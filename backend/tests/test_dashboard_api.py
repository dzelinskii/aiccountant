from datetime import date

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _setup(client: AsyncClient) -> dict[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c for c in cats if c["name"] == "Еда")
    return {"ws": ws, "acc": acc["id"], "food": food["id"]}


async def test_dashboard_aggregates(client: AsyncClient) -> None:
    s = await _setup(client)
    today = date.today().isoformat()
    await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={
            "account_id": s["acc"],
            "category_id": s["food"],
            "amount": "-300.00",
            "occurred_at": today,
        },
    )
    await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={
            "account_id": s["acc"],
            "category_id": s["food"],
            "amount": "-200.00",
            "occurred_at": today,
        },
    )

    resp = await client.get("/api/dashboard", params={"workspace_id": s["ws"]})
    assert resp.status_code == 200
    data = resp.json()

    card = next(a for a in data["accounts"] if a["id"] == s["acc"])
    assert card["balance"] == "-500.0000"

    food_exp = next(m for m in data["month_expenses"] if m["category_id"] == s["food"])
    assert food_exp["total"] == "500.0000"
    assert food_exp["category_name"] == "Еда"

    assert len(data["recent"]) == 2
    assert data["recent"][0]["is_transfer"] is False


async def test_dashboard_excludes_transfers_from_expenses(client: AsyncClient) -> None:
    s = await _setup(client)
    acc2 = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": s["ws"]},
            json={"name": "Нал", "type": "cash", "currency": "RUB"},
        )
    ).json()
    await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": s["ws"]},
        json={
            "from_account_id": s["acc"],
            "to_account_id": acc2["id"],
            "from_amount": "1000.00",
            "to_amount": "1000.00",
            "occurred_at": date.today().isoformat(),
        },
    )
    resp = await client.get("/api/dashboard", params={"workspace_id": s["ws"]})
    assert resp.json()["month_expenses"] == []


async def test_uncategorized_expenses_bucket(client: AsyncClient) -> None:
    s = await _setup(client)
    today = date.today().isoformat()
    # расход без категории
    await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={"account_id": s["acc"], "amount": "-400.00", "occurred_at": today},
    )
    resp = await client.get("/api/dashboard", params={"workspace_id": s["ws"]})
    bucket = next(m for m in resp.json()["month_expenses"] if m["category_id"] is None)
    assert bucket["category_name"] == "Без категории"
    assert bucket["total"] == "400.0000"


async def test_dashboard_excludes_future_month_expenses(client: AsyncClient) -> None:
    # расход, датированный следующим месяцем, не входит в расходы текущего месяца
    s = await _setup(client)
    today = date.today()
    future = (
        today.replace(year=today.year + 1, month=1, day=15)
        if today.month == 12
        else today.replace(month=today.month + 1, day=15)
    )
    await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={
            "account_id": s["acc"],
            "category_id": s["food"],
            "amount": "-999.00",
            "occurred_at": future.isoformat(),
        },
    )
    resp = await client.get("/api/dashboard", params={"workspace_id": s["ws"]})
    assert resp.json()["month_expenses"] == []
