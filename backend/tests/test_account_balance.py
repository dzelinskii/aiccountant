import json
from decimal import Decimal
from typing import Any

from httpx import AsyncClient, Response

from app.ledger.balance import adjustment_for, visible_balance

ALICE = {"email": "alice@example.com", "password": "password123"}


def test_reported_balance_wins() -> None:
    # источник сообщил остаток — он и показывается, поправка не участвует
    assert visible_balance(Decimal("100.00"), Decimal("999.00"), Decimal("-50.00")) == Decimal(
        "100.00"
    )


def test_without_reported_sum_and_adjustment() -> None:
    assert visible_balance(None, Decimal("5000.00"), Decimal("-200.00")) == Decimal("4800.00")


def test_without_reported_and_without_adjustment() -> None:
    # поведение до этой задачи: остаток равен сумме операций
    assert visible_balance(None, Decimal(0), Decimal("-122515.28")) == Decimal("-122515.28")


def test_adjustment_makes_desired_visible() -> None:
    operations = Decimal("-200.00")
    adjustment = adjustment_for(Decimal("4900.00"), operations)
    assert visible_balance(None, adjustment, operations) == Decimal("4900.00")


def test_reported_zero_is_not_absent() -> None:
    # ноль — законный остаток, а не «источник промолчал»
    assert visible_balance(Decimal(0), Decimal("777.00"), Decimal("13.00")) == Decimal(0)


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    account_id = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, str(account_id)


async def _account(client: AsyncClient, ws: str) -> dict[str, Any]:
    resp = await client.get("/api/accounts", params={"workspace_id": ws})
    assert resp.status_code == 200
    accounts: list[dict[str, Any]] = resp.json()
    assert len(accounts) == 1
    return accounts[0]


async def test_fresh_account_shows_zero(client: AsyncClient) -> None:
    ws, _ = await _ws_and_account(client)
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("0.00")


async def test_balance_follows_operations(client: AsyncClient) -> None:
    """У счёта без источника остаток по-прежнему равен сумме операций: разделение
    величин не должно менять то, что человек уже видит на экране."""
    ws, account_id = await _ws_and_account(client)
    posted = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": account_id, "amount": "-100.00", "occurred_at": "2026-09-01"},
    )
    assert posted.status_code == 201
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("-100.00")


async def test_account_carries_source_marks(client: AsyncClient) -> None:
    """Число без пометки, откуда оно и на какой момент верно, ничего не говорит:
    момент и метки карт обязаны быть в ответе и тогда, когда источника нет."""
    ws, _ = await _ws_and_account(client)
    account = await _account(client, ws)
    assert account["reported_at"] is None
    assert account["card_masks"] == []


OPERATION = {
    "occurred_at": "2026-09-01",
    "amount": "-100.00",
    "currency": "RUB",
    "description": "Кофейня",
    "external_id": "bank-op-1",
}


async def _start_import(
    client: AsyncClient, ws: str, account_id: str, account: dict[str, Any] | None
) -> Response:
    """Импорт от коллектора; блок счёта необязателен — разбор PDF его не даёт."""
    body: dict[str, Any] = {"parser": "tbank_collector", "operations": [OPERATION]}
    if account is not None:
        body["account"] = account
    return await client.post(
        "/api/imports/parsed", params={"workspace_id": ws, "account_id": account_id}, json=body
    )


async def _commit(client: AsyncClient, ws: str, import_id: str) -> None:
    resp = await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})
    assert resp.status_code == 200


async def test_reported_balance_applied_on_commit(client: AsyncClient) -> None:
    """Остаток от источника доезжает до счёта — и ровно в момент подтверждения.

    Отправленный, но не подтверждённый импорт счёта ещё не касается: человек
    может его и не принять. А после подтверждения показывается именно
    сообщённый остаток, а не сумма пришедших операций.
    """
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "12345.67"})
    assert started.status_code == 201
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("0.00")

    await _commit(client, ws, started.json()["import_id"])
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("12345.67")


async def test_reported_at_filled_on_commit(client: AsyncClient) -> None:
    """Остаток без момента, на который он верен, ничего не стоит: коллектор
    ходит в банк не каждую минуту, и человек должен видеть давность числа."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "12345.67"})
    await _commit(client, ws, started.json()["import_id"])

    assert (await _account(client, ws))["reported_at"] is not None


async def test_import_without_account_block_keeps_balance(client: AsyncClient) -> None:
    """Разбор PDF-выписки про счёт ничего не знает — такой импорт остаток не
    трогает, и счёт по-прежнему считается по операциям."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, None)
    await _commit(client, ws, started.json()["import_id"])

    account = await _account(client, ws)
    assert Decimal(account["balance"]) == Decimal("-100.00")
    assert account["reported_at"] is None


async def test_card_masks_reach_account(client: AsyncClient) -> None:
    """По последним цифрам карты человек и опознаёт, какой счёт перед ним."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(
        client, ws, account_id, {"balance": "12345.67", "card_masks": ["1234", "5678"]}
    )
    await _commit(client, ws, started.json()["import_id"])

    assert (await _account(client, ws))["card_masks"] == ["1234", "5678"]


async def test_overflow_balance_rejected(client: AsyncClient) -> None:
    """Больше NUMERIC(20,4) — без проверки на входе это DBAPIError уже при
    подтверждении, когда запись импорта успела уйти в ready."""
    ws, account_id = await _ws_and_account(client)
    resp = await _start_import(client, ws, account_id, {"balance": "1E+30"})
    assert resp.status_code == 422


async def test_card_mask_must_be_four_digits(client: AsyncClient) -> None:
    """Метка — ровно четыре цифры: всё остальное значит, что коллектор прислал
    кусок номера карты, а хранить его мы не собираемся."""
    ws, account_id = await _ws_and_account(client)
    for mask in ("12a4", "123"):
        resp = await _start_import(
            client, ws, account_id, {"balance": "100.00", "card_masks": [mask]}
        )
        assert resp.status_code == 422, mask


async def test_float_balance_rejected(client: AsyncClient) -> None:
    """Число JSON вместо строки теряет разряды ещё до валидации — то же правило,
    что у сумм операций."""
    ws, account_id = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": account_id},
        content=json.dumps(
            {
                "parser": "tbank_collector",
                "operations": [OPERATION],
                "account": {"balance": 12345678901234.5678},
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422
