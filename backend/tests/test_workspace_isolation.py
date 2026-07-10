"""Критические тесты изоляции данных между workspace.

Участник workspace B не должен видеть и менять данные workspace A:
403 при обращении к чужому workspace_id (не участник), 404 при попытке
дотянуться до чужой строки, подставив свой workspace_id.
"""

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _register_ws(client: AsyncClient, creds: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


async def test_member_cannot_read_foreign_workspace(client: AsyncClient) -> None:
    ws_a = await _register_ws(client, ALICE)
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_a},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()

    client.cookies.clear()
    await _register_ws(client, BOB)  # у Боба свой workspace

    # Боб пытается читать чужой workspace_id — 403 (не участник)
    resp = await client.get("/api/accounts", params={"workspace_id": ws_a})
    assert resp.status_code == 403

    # прямой доступ к чужому счёту, подставляя СВОЙ workspace — счёт не найден
    me = await client.get("/api/me")
    ws_b = me.json()["workspaces"][0]["id"]
    resp2 = await client.patch(
        f"/api/accounts/{acc['id']}", params={"workspace_id": ws_b}, json={"name": "Взлом"}
    )
    assert resp2.status_code == 404


async def test_member_cannot_delete_foreign_transaction(client: AsyncClient) -> None:
    ws_a = await _register_ws(client, ALICE)
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_a},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()
    cats = (await client.get("/api/categories", params={"workspace_id": ws_a})).json()
    food = next(c for c in cats if c["name"] == "Еда")
    txn = (
        await client.post(
            "/api/transactions",
            params={"workspace_id": ws_a},
            json={
                "account_id": acc["id"],
                "category_id": food["id"],
                "amount": "-100.00",
                "occurred_at": "2026-07-05",
            },
        )
    ).json()

    client.cookies.clear()
    ws_b = await _register_ws(client, BOB)
    resp = await client.delete(f"/api/transactions/{txn['id']}", params={"workspace_id": ws_b})
    assert resp.status_code == 404  # чужая операция не видна в своём workspace

    # и данные A на месте
    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    lst = (await client.get("/api/transactions", params={"workspace_id": ws_a})).json()
    assert lst["total"] == 1


async def test_member_cannot_dismiss_foreign_suggestion(client: AsyncClient) -> None:
    ws_a = await _register_ws(client, ALICE)
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_a},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()
    cats = (await client.get("/api/categories", params={"workspace_id": ws_a})).json()
    food = next(c for c in cats if c["name"] == "Еда")
    txn = (
        await client.post(
            "/api/transactions",
            params={"workspace_id": ws_a},
            json={
                "account_id": acc["id"],
                "category_id": food["id"],
                "amount": "-100.00",
                "occurred_at": "2026-07-05",
            },
        )
    ).json()

    client.cookies.clear()
    ws_b = await _register_ws(client, BOB)
    # Боб сбрасывает подсказку по чужой операции, подставляя свой workspace — не видна
    resp = await client.post(
        f"/api/transactions/{txn['id']}/dismiss-suggestion",
        params={"workspace_id": ws_b},
    )
    assert resp.status_code == 404


async def test_member_cannot_use_foreign_account_in_transaction(client: AsyncClient) -> None:
    ws_a = await _register_ws(client, ALICE)
    acc_a = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_a},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()

    client.cookies.clear()
    ws_b = await _register_ws(client, BOB)
    cats_b = (await client.get("/api/categories", params={"workspace_id": ws_b})).json()
    food_b = next(c for c in cats_b if c["name"] == "Еда")

    # Боб пытается создать операцию по чужому (Алисиному) счёту в своём workspace
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": ws_b},
        json={
            "account_id": acc_a["id"],
            "category_id": food_b["id"],
            "amount": "-100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp.status_code == 404

    # и по чужой категории на свой счёт
    acc_b = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_b},
            json={"name": "Нал", "type": "cash", "currency": "RUB"},
        )
    ).json()
    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    cats_a = (await client.get("/api/categories", params={"workspace_id": ws_a})).json()
    food_a = next(c for c in cats_a if c["name"] == "Еда")
    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)

    resp2 = await client.post(
        "/api/transactions",
        params={"workspace_id": ws_b},
        json={
            "account_id": acc_b["id"],
            "category_id": food_a["id"],
            "amount": "-100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp2.status_code == 404


async def test_transfer_rejects_foreign_account(client: AsyncClient) -> None:
    ws_a = await _register_ws(client, ALICE)
    acc_a = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_a},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()

    client.cookies.clear()
    ws_b = await _register_ws(client, BOB)
    acc_b = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_b},
            json={"name": "Нал", "type": "cash", "currency": "RUB"},
        )
    ).json()

    # Боб пытается перевести на/со своего счёта, указав чужой (Алисин) счёт вторым концом
    resp = await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": ws_b},
        json={
            "from_account_id": acc_b["id"],
            "to_account_id": acc_a["id"],
            "from_amount": "100.00",
            "to_amount": "100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp.status_code == 422

    # и наоборот — чужой счёт как источник
    resp2 = await client.post(
        "/api/transactions/transfer",
        params={"workspace_id": ws_b},
        json={
            "from_account_id": acc_a["id"],
            "to_account_id": acc_b["id"],
            "from_amount": "100.00",
            "to_amount": "100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert resp2.status_code == 422

    # баланс Алисиного счёта не тронут
    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    accounts = (await client.get("/api/accounts", params={"workspace_id": ws_a})).json()
    assert accounts[0]["balance"] == "0.0000"


async def test_dashboard_scoped_to_own_workspace(client: AsyncClient) -> None:
    ws_a = await _register_ws(client, ALICE)
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_a},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()
    cats = (await client.get("/api/categories", params={"workspace_id": ws_a})).json()
    food = next(c for c in cats if c["name"] == "Еда")
    await client.post(
        "/api/transactions",
        params={"workspace_id": ws_a},
        json={
            "account_id": acc["id"],
            "category_id": food["id"],
            "amount": "-300.00",
            "occurred_at": "2026-07-05",
        },
    )

    client.cookies.clear()
    await _register_ws(client, BOB)

    # Боб не может получить дашборд чужого workspace
    resp = await client.get("/api/dashboard", params={"workspace_id": ws_a})
    assert resp.status_code == 403
