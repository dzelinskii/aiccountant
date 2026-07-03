from httpx import AsyncClient

REGISTER = {"email": "alice@example.com", "password": "password123"}


async def test_register_creates_user_and_workspace(client: AsyncClient) -> None:
    response = await client.post("/api/auth/register", json=REGISTER)
    assert response.status_code == 201
    assert response.json()["email"] == "alice@example.com"
    assert "session" in response.cookies

    me = await client.get("/api/me")
    assert me.status_code == 200
    body = me.json()
    assert body["email"] == "alice@example.com"
    assert len(body["workspaces"]) == 1
    assert body["workspaces"][0]["role"] == "owner"


async def test_register_duplicate_email_conflict(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    response = await client.post("/api/auth/register", json=REGISTER)
    assert response.status_code == 409


async def test_register_short_password_rejected(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register", json={"email": "bob@example.com", "password": "short"}
    )
    assert response.status_code == 422


async def test_login_and_wrong_password(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    client.cookies.clear()

    ok = await client.post("/api/auth/login", json=REGISTER)
    assert ok.status_code == 200
    assert "session" in ok.cookies

    client.cookies.clear()
    bad = await client.post(
        "/api/auth/login", json={"email": "alice@example.com", "password": "wrong-password"}
    )
    assert bad.status_code == 401


async def test_me_requires_auth(client: AsyncClient) -> None:
    response = await client.get("/api/me")
    assert response.status_code == 401


async def test_logout_kills_session(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    assert (await client.get("/api/me")).status_code == 200

    logout = await client.post("/api/auth/logout")
    assert logout.status_code == 204
    assert (await client.get("/api/me")).status_code == 401


async def test_email_case_insensitive(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    dup = await client.post(
        "/api/auth/register", json={"email": "Alice@Example.com", "password": "password123"}
    )
    assert dup.status_code == 409

    client.cookies.clear()
    login = await client.post(
        "/api/auth/login", json={"email": "ALICE@example.com", "password": "password123"}
    )
    assert login.status_code == 200
