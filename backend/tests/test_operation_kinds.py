import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.operation_kinds import NON_SPENDING_KINDS, OPERATION_KINDS
from app.ledger import repository as ledger_repository
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


def _op(amount: str, kind: str, external_id: str) -> dict[str, str]:
    """Операция для импорта. Дата — сегодняшняя: расходы месяца на дашборде
    считаются от текущего месяца."""
    return {
        "occurred_at": date.today().isoformat(),
        "amount": amount,
        "currency": "RUB",
        "description": "Операция",
        "external_id": external_id,
        "kind": kind,
    }


async def _import_operations(
    client: AsyncClient, ws: str, account_id: str, operations: list[dict[str, str]]
) -> None:
    """Создать операции заданных видов. Импорт — единственный источник, который
    вид сообщает: ручной ввод выводит его из знака суммы, так что через него
    ни перевод человеку, ни погашение кредита не задать."""
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": account_id},
        json={"parser": "tbank_collector", "operations": operations},
    )
    assert started.status_code == 201
    committed = await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.status_code == 200
    assert committed.json()["imported"] == len(operations)


async def _kinds(client: AsyncClient, ws: str) -> list[str]:
    """Виды всех операций workspace, по алфавиту: порядок строк одной даты не задан."""
    resp = await client.get("/api/transactions", params={"workspace_id": ws})
    assert resp.status_code == 200
    return sorted(t["operation_kind"] for t in resp.json()["items"])


async def _month_expenses(client: AsyncClient, ws: str) -> Decimal:
    resp = await client.get("/api/dashboard", params={"workspace_id": ws})
    assert resp.status_code == 200
    return sum((Decimal(bucket["total"]) for bucket in resp.json()["month_expenses"]), Decimal(0))


async def test_transfer_self_out_of_month_expenses(client: AsyncClient) -> None:
    """Движение между своими счетами деньги не тратит — в расходах месяца
    остаётся только покупка рядом."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(
        client,
        ws,
        card,
        [_op("-1000.00", "transfer_self", "op-self"), _op("-300.00", "purchase", "op-buy")],
    )
    assert await _month_expenses(client, ws) == Decimal("300.00")


async def test_cash_out_of_month_expenses(client: AsyncClient) -> None:
    """Снятие наличных меняет форму денег, а не тратит их."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(
        client,
        ws,
        card,
        [_op("-2000.00", "cash", "op-cash"), _op("-300.00", "purchase", "op-buy")],
    )
    assert await _month_expenses(client, ws) == Decimal("300.00")


async def test_unknown_stays_in_month_expenses(client: AsyncClient) -> None:
    """Вид неизвестен — операция всё равно видна в расходах: молча исчезать
    из статистики она не должна."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(client, ws, card, [_op("-300.00", "unknown", "op-unknown")])
    assert await _kinds(client, ws) == ["unknown"]
    assert await _month_expenses(client, ws) == Decimal("300.00")


async def test_loan_and_transfer_person_stay_in_month_expenses(client: AsyncClient) -> None:
    """Погашение кредита и перевод человеку уносят деньги из домохозяйства —
    это расход, а не перекладывание между своими счетами."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(
        client,
        ws,
        card,
        [_op("-5000.00", "loan", "op-loan"), _op("-700.00", "transfer_person", "op-person")],
    )
    # сами виды проверяем отдельно: по одной сумме расходов такая операция
    # неотличима от unknown, и тест не заметил бы, что вид до строки не доехал
    assert await _kinds(client, ws) == ["loan", "transfer_person"]
    assert await _month_expenses(client, ws) == Decimal("5700.00")


async def _id_by_kind(client: AsyncClient, ws: str, kind: str) -> str:
    resp = await client.get("/api/transactions", params={"workspace_id": ws})
    assert resp.status_code == 200
    return str(next(t["id"] for t in resp.json()["items"] if t["operation_kind"] == kind))


async def _set_override(
    client: AsyncClient, ws: str, txn_id: str, value: bool | None
) -> dict[str, Any]:
    resp = await client.patch(
        f"/api/transactions/{txn_id}",
        params={"workspace_id": ws},
        json={"spending_override": value},
    )
    assert resp.status_code == 200
    item: dict[str, Any] = resp.json()
    return item


async def test_override_returns_operation_to_expenses(client: AsyncClient) -> None:
    """Человек перевёл деньги себе на другой счёт, но по смыслу это трата —
    его решение возвращает операцию в расходы."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(client, ws, card, [_op("-5000.00", "transfer_self", "op-self")])
    assert await _month_expenses(client, ws) == Decimal(0)

    item = await _set_override(client, ws, await _id_by_kind(client, ws, "transfer_self"), True)
    assert item["spending_override"] is True
    assert item["counts_as_spending"] is True
    assert await _month_expenses(client, ws) == Decimal("5000.00")


async def test_override_removes_purchase_from_expenses(client: AsyncClient) -> None:
    """Решение человека работает и в обратную сторону: покупку можно вынести
    из расходов, не выдумывая ей ложный вид операции."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(client, ws, card, [_op("-100.00", "purchase", "op-buy")])

    item = await _set_override(client, ws, await _id_by_kind(client, ws, "purchase"), False)
    assert item["counts_as_spending"] is False
    assert await _month_expenses(client, ws) == Decimal(0)


async def test_override_can_be_reset_to_rule(client: AsyncClient) -> None:
    """Сброс решения в null возвращает операцию под правило по виду. Без этого
    передумать через API нельзя: null неотличим от «поле не прислали»."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(client, ws, card, [_op("-5000.00", "transfer_self", "op-self")])
    txn_id = await _id_by_kind(client, ws, "transfer_self")

    await _set_override(client, ws, txn_id, True)
    assert await _month_expenses(client, ws) == Decimal("5000.00")

    item = await _set_override(client, ws, txn_id, None)
    assert item["spending_override"] is None
    assert item["counts_as_spending"] is False
    assert await _month_expenses(client, ws) == Decimal(0)


async def test_override_does_not_touch_operation_kind(client: AsyncClient) -> None:
    """Решение человека и вид операции — разные поля: факт от источника
    переопределением не затирается."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(client, ws, card, [_op("-5000.00", "transfer_self", "op-self")])

    item = await _set_override(client, ws, await _id_by_kind(client, ws, "transfer_self"), True)
    assert item["operation_kind"] == "transfer_self"
    assert await _kinds(client, ws) == ["transfer_self"]


async def test_counts_as_spending_agrees_with_month_expenses(client: AsyncClient) -> None:
    """Поле в ответе и цифры статистики считаются одним правилом: суммируем то,
    что ответ пометил тратой, и сверяем с расходами месяца."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(
        client,
        ws,
        card,
        [
            _op("-300.00", "purchase", "op-buy"),
            _op("-1000.00", "transfer_self", "op-self"),
            _op("-700.00", "cash", "op-cash"),
        ],
    )
    # человек спорит с умолчанием в обе стороны сразу
    await _set_override(client, ws, await _id_by_kind(client, ws, "transfer_self"), True)
    await _set_override(client, ws, await _id_by_kind(client, ws, "purchase"), False)

    items = (await client.get("/api/transactions", params={"workspace_id": ws})).json()["items"]
    counted = sum((-Decimal(t["amount"]) for t in items if t["counts_as_spending"]), Decimal(0))
    assert counted == Decimal("1000.00")
    assert counted == await _month_expenses(client, ws)


async def test_dashboard_feed_marks_imported_transfer(client: AsyncClient) -> None:
    """Односторонний перевод из импорта в ленте помечен: категории у него не
    будет никогда, и прочерк без объяснения противоречил бы цифрам расходов."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(
        client,
        ws,
        card,
        [_op("-1000.00", "transfer_self", "op-self"), _op("-300.00", "purchase", "op-buy")],
    )

    recent = (await client.get("/api/dashboard", params={"workspace_id": ws})).json()["recent"]
    assert {t["amount"]: t["counts_as_spending"] for t in recent} == {
        "-1000.0000": False,
        "-300.0000": True,
    }


async def test_transfer_self_not_offered_for_categorization(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Категоризации нечего делать с перекладыванием денег между своими счетами:
    правило участия в статистике одно и на дашборде, и здесь."""
    ws, card, _ = await _ws_and_accounts(client)
    await _import_operations(
        client,
        ws,
        card,
        [_op("-1000.00", "transfer_self", "op-self"), _op("-300.00", "purchase", "op-buy")],
    )
    rows = await ledger_repository.list_uncategorized(db_session, uuid.UUID(ws))
    assert [t.operation_kind for t in rows] == ["purchase"]
