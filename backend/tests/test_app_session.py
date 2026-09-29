from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _session_token(client: AsyncClient) -> str:
    """Сессия, выданная браузеру, — тот же токен, что приложение получит в ответе."""
    await client.post("/api/auth/register", json=ALICE)
    token = client.cookies["session"]
    client.cookies.clear()
    return token


async def test_session_header_authorizes(client: AsyncClient) -> None:
    token = await _session_token(client)
    resp = await client.get("/api/me", headers={"Authorization": f"Session {token}"})
    assert resp.status_code == 200
    assert resp.json()["email"] == ALICE["email"]


async def test_unknown_session_rejected(client: AsyncClient) -> None:
    resp = await client.get("/api/me", headers={"Authorization": "Session no-such-session"})
    assert resp.status_code == 401


async def test_empty_session_rejected(client: AsyncClient) -> None:
    resp = await client.get("/api/me", headers={"Authorization": "Session "})
    assert resp.status_code == 401


async def test_session_header_is_a_person_not_a_token(client: AsyncClient) -> None:
    """Сессия приложения — человек, а не машинный токен: ей доступно то, что
    require_session_user запрещает токенам (выпуск токена — одно из таких)."""
    token = await _session_token(client)
    headers = {"Authorization": f"Session {token}"}
    ws = (await client.get("/api/me", headers=headers)).json()["workspaces"][0]["id"]
    resp = await client.post(
        "/api/tokens", params={"workspace_id": ws}, json={"name": "к"}, headers=headers
    )
    assert resp.status_code == 201


async def test_logout_with_session_header_ends_that_session(client: AsyncClient) -> None:
    token = await _session_token(client)
    headers = {"Authorization": f"Session {token}"}
    # без этой проверки тест зелёный и там, где сессию заголовком не принимают вовсе
    assert (await client.get("/api/me", headers=headers)).status_code == 200
    assert (await client.post("/api/auth/logout", headers=headers)).status_code == 204
    assert (await client.get("/api/me", headers=headers)).status_code == 401
