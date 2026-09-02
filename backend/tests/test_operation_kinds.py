import uuid
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.operation_kinds import NON_SPENDING_KINDS, OPERATION_KINDS
from app.ledger import service as ledger_service
from app.recurring import service as recurring_service

ALICE = {"email": "alice@example.com", "password": "password123"}
TODAY = date(2026, 9, 20)


def test_dictionary_lists_every_kind() -> None:
    """Словарь — договор с коннекторами и с колонкой в БД: расширять его молча
    нельзя, поэтому состав зафиксирован здесь целиком."""
    assert OPERATION_KINDS == (
        "purchase",
        "transfer_person",
        "transfer_self",
        "cash",
        "loan",
        "income",
        "unknown",
    )


def test_kinds_fit_the_column() -> None:
    """Вид хранится в String(20): более длинный упадёт на вставке, а не на ревью."""
    assert max(len(kind) for kind in OPERATION_KINDS) <= 20


def test_non_spending_kinds_are_known() -> None:
    """Список исключаемых видов не должен разъезжаться со словарём."""
    assert set(NON_SPENDING_KINDS) <= set(OPERATION_KINDS)


def test_unknown_is_not_excluded() -> None:
    """unknown остаётся тратой: ничего не исчезает молча."""
    assert "unknown" not in NON_SPENDING_KINDS


async def _ws_and_accounts(client: AsyncClient) -> tuple[str, str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    card = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    cash = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Нал", "type": "cash", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, card, cash


async def _user_ws_account(client: AsyncClient) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """То же, но идентификаторами — для вызовов сервиса в обход HTTP."""
    ws, card, _ = await _ws_and_accounts(client)
    me = (await client.get("/api/me")).json()
    return uuid.UUID(me["id"]), uuid.UUID(ws), uuid.UUID(card)


async def test_manual_expense_is_purchase(client: AsyncClient) -> None:
    ws, card, _ = await _ws_and_accounts(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": card, "amount": "-100.00", "occurred_at": "2026-09-01"},
    )
    assert resp.status_code == 201
    assert resp.json()["operation_kind"] == "purchase"
    # решения человека ещё не было — правило по виду операции решает само
    assert resp.json()["spending_override"] is None


async def test_manual_income_is_income(client: AsyncClient) -> None:
    ws, card, _ = await _ws_and_accounts(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": card, "amount": "100.00", "occurred_at": "2026-09-01"},
    )
    assert resp.status_code == 201
    assert resp.json()["operation_kind"] == "income"
    assert resp.json()["spending_override"] is None


async def test_transfer_rows_are_transfer_self(client: AsyncClient) -> None:
    """Обе строки перевода — движение между своими счетами, а не трата."""
    ws, card, cash = await _ws_and_accounts(client)
    resp = await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": ws},
        json={
            "from_account_id": card,
            "to_account_id": cash,
            "from_amount": "1000.00",
            "to_amount": "1000.00",
            "occurred_at": "2026-09-01",
        },
    )
    assert resp.status_code == 201
    items = resp.json()["items"]
    assert len(items) == 2
    assert all(t["operation_kind"] == "transfer_self" for t in items)


async def test_post_transaction_defaults_to_unknown(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Источник, не сообщивший вид, получает unknown: именно на этом умолчании
    держится решение, участвует ли операция в статистике."""
    user_id, ws, account_id = await _user_ws_account(client)
    transaction = await ledger_service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=account_id,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 9, 1),
        source="import",
    )
    assert transaction.operation_kind == "unknown"


async def test_post_transaction_keeps_given_kind(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Вид, сообщённый источником, доезжает до строки без изменений."""
    user_id, ws, account_id = await _user_ws_account(client)
    transaction = await ledger_service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=account_id,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 9, 1),
        source="import",
        operation_kind="transfer_person",
    )
    assert transaction.operation_kind == "transfer_person"


async def _rule(client: AsyncClient, *, mode: str, amount: str) -> str:
    ws, card, _ = await _ws_and_accounts(client)
    await client.post(
        "/api/recurring",
        params={"workspace_id": ws},
        json={
            "account_id": card,
            "amount": amount,
            "period": "month",
            "interval": 1,
            "anchor_day": 5,
            "start_date": "2026-01-05",
            "mode": mode,
        },
    )
    return ws


async def test_recurring_autopost_kind_by_sign(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Автосписание по правилу — такая же трата, как ручной ввод: вид выводится
    из знака и не должен оставаться неизвестным."""
    ws = await _rule(client, mode="autopost", amount="-30000.00")
    await recurring_service.process_due_rules(db_session, TODAY)

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 1
    assert txns["items"][0]["operation_kind"] == "purchase"


async def test_recurring_confirmation_kind_by_sign(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws = await _rule(client, mode="remind", amount="-30000.00")
    await recurring_service.process_due_rules(db_session, TODAY)
    pending = (
        await client.get(
            "/api/recurring/occurrences", params={"workspace_id": ws, "status": "pending"}
        )
    ).json()
    await client.post(
        f"/api/recurring/occurrences/{pending[0]['id']}/confirm",
        params={"workspace_id": ws},
        json={},
    )

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 1
    assert txns["items"][0]["operation_kind"] == "purchase"


async def test_manual_kind_follows_sign_change(client: AsyncClient) -> None:
    """У ручного ввода вид выведен из знака — при смене знака он обязан
    пересчитаться, иначе факт разойдётся с суммой."""
    ws, card, _ = await _ws_and_accounts(client)
    txn = (
        await client.post(
            "/api/transactions",
            params={"workspace_id": ws},
            json={"account_id": card, "amount": "-100.00", "occurred_at": "2026-09-01"},
        )
    ).json()
    assert txn["operation_kind"] == "purchase"

    patched = await client.patch(
        f"/api/transactions/{txn['id']}",
        params={"workspace_id": ws},
        json={"amount": "100.00"},
    )
    assert patched.status_code == 200
    assert patched.json()["operation_kind"] == "income"


async def test_imported_kind_survives_amount_edit(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """У импорта вид — факт от банка: правка суммы человеком его не затирает."""
    user_id, ws, account_id = await _user_ws_account(client)
    transaction = await ledger_service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=account_id,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 9, 1),
        source="import",
        operation_kind="transfer_person",
    )
    await db_session.commit()

    patched = await client.patch(
        f"/api/transactions/{transaction.id}",
        params={"workspace_id": str(ws)},
        json={"amount": "100.00"},
    )
    assert patched.status_code == 200
    assert patched.json()["operation_kind"] == "transfer_person"
