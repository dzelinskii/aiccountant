from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _register_and_get_workspace_id(client: AsyncClient, creds: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    workspace_id: str = me.json()["workspaces"][0]["id"]
    return workspace_id


async def test_owner_invites_existing_user(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=BOB)
    client.cookies.clear()
    workspace_id = await _register_and_get_workspace_id(client, ALICE)

    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]}
    )
    assert response.status_code == 201
    assert response.json()["role"] == "member"

    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)
    me = await client.get("/api/me")
    roles = {ws["role"] for ws in me.json()["workspaces"]}
    assert roles == {"owner", "member"}


async def test_member_cannot_invite(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=BOB)
    client.cookies.clear()
    workspace_id = await _register_and_get_workspace_id(client, ALICE)
    await client.post(f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]})

    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)
    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": ALICE["email"]}
    )
    assert response.status_code == 403


async def test_invite_unknown_email_not_found(client: AsyncClient) -> None:
    workspace_id = await _register_and_get_workspace_id(client, ALICE)
    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": "ghost@example.com"}
    )
    assert response.status_code == 404


async def test_invite_twice_conflict(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=BOB)
    client.cookies.clear()
    workspace_id = await _register_and_get_workspace_id(client, ALICE)
    await client.post(f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]})
    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]}
    )
    assert response.status_code == 409
