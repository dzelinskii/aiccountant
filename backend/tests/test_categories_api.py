from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _register(client: AsyncClient) -> str:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


async def test_default_categories_seeded_on_register(client: AsyncClient) -> None:
    ws = await _register(client)
    resp = await client.get("/api/categories", params={"workspace_id": ws})
    assert resp.status_code == 200
    names = {c["name"] for c in resp.json()}
    assert {"Еда", "Транспорт", "Зарплата"} <= names
    kinds = {c["kind"] for c in resp.json()}
    assert kinds == {"income", "expense"}


async def test_create_subcategory(client: AsyncClient) -> None:
    ws = await _register(client)
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c for c in cats if c["name"] == "Еда")

    resp = await client.post(
        "/api/categories",
        params={"workspace_id": ws},
        json={"name": "Кафе", "kind": "expense", "parent_id": food["id"]},
    )
    assert resp.status_code == 201
    assert resp.json()["parent_id"] == food["id"]


async def test_rename_category(client: AsyncClient) -> None:
    ws = await _register(client)
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    other = next(c for c in cats if c["name"] == "Прочее")
    resp = await client.patch(
        f"/api/categories/{other['id']}",
        params={"workspace_id": ws},
        json={"name": "Разное"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Разное"


async def test_parent_from_foreign_workspace_rejected(client: AsyncClient) -> None:
    # родитель из чужого workspace недопустим — иначе межворкспейсная ссылка
    ws_a = await _register(client)
    cats_a = (await client.get("/api/categories", params={"workspace_id": ws_a})).json()
    foreign_parent = next(c for c in cats_a if c["name"] == "Еда")["id"]

    client.cookies.clear()
    await client.post(
        "/api/auth/register", json={"email": "bob@example.com", "password": "password123"}
    )
    me = await client.get("/api/me")
    ws_b = me.json()["workspaces"][0]["id"]
    resp = await client.post(
        "/api/categories",
        params={"workspace_id": ws_b},
        json={"name": "Кафе", "kind": "expense", "parent_id": foreign_parent},
    )
    assert resp.status_code == 404
