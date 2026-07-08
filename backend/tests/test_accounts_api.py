from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _register(client: AsyncClient, creds: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


async def test_create_and_list_account(client: AsyncClient) -> None:
    ws = await _register(client, ALICE)
    resp = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": "Карта", "type": "card", "currency": "RUB"},
    )
    assert resp.status_code == 201
    created = resp.json()
    assert created["name"] == "Карта"
    assert created["balance"] == "0.0000"
    assert isinstance(created["balance"], str)

    lst = await client.get("/api/accounts", params={"workspace_id": ws})
    assert lst.status_code == 200
    assert len(lst.json()) == 1
    assert lst.json()[0]["id"] == created["id"]


async def test_rename_and_archive_account(client: AsyncClient) -> None:
    ws = await _register(client, ALICE)
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Нал", "type": "cash", "currency": "RUB"},
        )
    ).json()

    patched = await client.patch(
        f"/api/accounts/{acc['id']}",
        params={"workspace_id": ws},
        json={"name": "Наличные", "is_archived": True},
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Наличные"
    assert patched.json()["is_archived"] is True


async def test_non_member_gets_403(client: AsyncClient) -> None:
    ws = await _register(client, ALICE)
    client.cookies.clear()
    await client.post(
        "/api/auth/register", json={"email": "bob@example.com", "password": "password123"}
    )
    resp = await client.get("/api/accounts", params={"workspace_id": ws})
    assert resp.status_code == 403
