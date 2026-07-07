from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _setup(client: AsyncClient) -> dict[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc1 = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()
    acc2 = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Нал", "type": "cash", "currency": "RUB"},
        )
    ).json()
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c for c in cats if c["name"] == "Еда")
    salary = next(c for c in cats if c["name"] == "Зарплата")
    return {
        "ws": ws,
        "acc1": acc1["id"],
        "acc2": acc2["id"],
        "food": food["id"],
        "salary": salary["id"],
    }


async def test_expense_and_balance(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={
            "account_id": s["acc1"],
            "category_id": s["food"],
            "amount": "-500.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp.status_code == 201
    assert resp.json()["currency"] == "RUB"

    accounts = (await client.get("/api/accounts", params={"workspace_id": s["ws"]})).json()
    card = next(a for a in accounts if a["id"] == s["acc1"])
    assert card["balance"] == "-500.0000"


async def test_sign_must_match_kind(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={
            "account_id": s["acc1"],
            "category_id": s["food"],
            "amount": "500.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp.status_code == 422


async def test_transfer_atomic_pair(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": s["ws"]},
        json={
            "from_account_id": s["acc1"],
            "to_account_id": s["acc2"],
            "from_amount": "1000.00",
            "to_amount": "1000.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp.status_code == 201

    accounts = (await client.get("/api/accounts", params={"workspace_id": s["ws"]})).json()
    by_id = {a["id"]: a["balance"] for a in accounts}
    assert by_id[s["acc1"]] == "-1000.0000"
    assert by_id[s["acc2"]] == "1000.0000"

    lst = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    assert lst["total"] == 2
    assert all(t["transfer_group_id"] is not None for t in lst["items"])


async def test_transfer_same_account_rejected(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": s["ws"]},
        json={
            "from_account_id": s["acc1"],
            "to_account_id": s["acc1"],
            "from_amount": "100.00",
            "to_amount": "100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp.status_code == 422


async def test_delete_transfer_removes_both(client: AsyncClient) -> None:
    s = await _setup(client)
    await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": s["ws"]},
        json={
            "from_account_id": s["acc1"],
            "to_account_id": s["acc2"],
            "from_amount": "1000.00",
            "to_amount": "1000.00",
            "occurred_at": "2026-07-05",
        },
    )
    lst = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    one_id = lst["items"][0]["id"]

    resp = await client.delete(f"/api/transactions/{one_id}", params={"workspace_id": s["ws"]})
    assert resp.status_code == 204
    after = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    assert after["total"] == 0


async def test_patch_transfer_row_forbidden(client: AsyncClient) -> None:
    s = await _setup(client)
    await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": s["ws"]},
        json={
            "from_account_id": s["acc1"],
            "to_account_id": s["acc2"],
            "from_amount": "1000.00",
            "to_amount": "1000.00",
            "occurred_at": "2026-07-05",
        },
    )
    lst = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    one_id = lst["items"][0]["id"]
    resp = await client.patch(
        f"/api/transactions/{one_id}",
        params={"workspace_id": s["ws"]},
        json={"note": "правка"},
    )
    assert resp.status_code == 409


async def test_list_pagination_and_filter(client: AsyncClient) -> None:
    s = await _setup(client)
    for i in range(3):
        await client.post(
            "/api/transactions",
            params={"workspace_id": s["ws"]},
            json={
                "account_id": s["acc1"],
                "category_id": s["food"],
                "amount": "-100.00",
                "occurred_at": f"2026-07-0{i + 1}",
            },
        )
    page = (
        await client.get(
            "/api/transactions",
            params={"workspace_id": s["ws"], "limit": 2, "offset": 0},
        )
    ).json()
    assert page["total"] == 3
    assert len(page["items"]) == 2

    by_acc = (
        await client.get(
            "/api/transactions",
            params={"workspace_id": s["ws"], "account_id": s["acc2"]},
        )
    ).json()
    assert by_acc["total"] == 0
