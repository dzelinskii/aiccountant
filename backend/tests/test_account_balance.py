from decimal import Decimal
from typing import Any

from httpx import AsyncClient

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
