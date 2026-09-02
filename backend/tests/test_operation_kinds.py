from httpx import AsyncClient

from app.core.operation_kinds import NON_SPENDING_KINDS, OPERATION_KINDS

ALICE = {"email": "alice@example.com", "password": "password123"}


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
