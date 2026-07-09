import uuid

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = me.json()["workspaces"][0]["id"]
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def test_manual_create_without_category_enqueues(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, acc = await _ws_and_account(client)
    await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": acc, "amount": "-100.00", "occurred_at": "2026-07-05"},
    )
    assert uuid.UUID(ws) in stub_categorize_enqueue


async def test_manual_create_with_category_does_not_enqueue(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, acc = await _ws_and_account(client)
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c["id"] for c in cats if c["name"] == "Еда")
    await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={
            "account_id": acc,
            "category_id": food,
            "amount": "-100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert stub_categorize_enqueue == []
