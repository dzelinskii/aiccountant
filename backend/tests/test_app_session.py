from httpx import AsyncClient, Response

ALICE = {"email": "alice@example.com", "password": "password123"}
TAURI_ORIGIN = "http://tauri.localhost"


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


async def test_scheme_is_case_insensitive(client: AsyncClient) -> None:
    token = await _session_token(client)
    resp = await client.get("/api/me", headers={"Authorization": f"session {token}"})
    assert resp.status_code == 200


async def test_empty_session_header_does_not_fall_back_to_cookie(client: AsyncClient) -> None:
    """Заголовок решает сам: пустая схема Session не должна тихо превращаться в
    запрос от того, чья кука случайно лежит в том же клиенте."""
    await client.post("/api/auth/register", json=ALICE)
    assert (await client.get("/api/me")).status_code == 200  # кука действует
    resp = await client.get("/api/me", headers={"Authorization": "Session "})
    assert resp.status_code == 401


async def test_api_token_is_not_accepted_as_session(client: AsyncClient) -> None:
    """Утёкший машинный токен не должен получить права человека, если его
    предъявить под схемой Session."""
    await client.post("/api/auth/register", json=ALICE)
    ws = (await client.get("/api/me")).json()["workspaces"][0]["id"]
    api_token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]
    client.cookies.clear()
    resp = await client.get("/api/me", headers={"Authorization": f"Session {api_token}"})
    assert resp.status_code == 401


async def test_session_token_is_not_accepted_as_bearer(client: AsyncClient) -> None:
    token = await _session_token(client)
    resp = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


async def test_app_login_returns_token_not_cookie(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=ALICE)
    client.cookies.clear()

    resp = await client.post("/api/auth/login", json={**ALICE, "client": "app"})

    assert resp.status_code == 200
    token = resp.json()["session_token"]
    assert token
    assert "session" not in resp.cookies
    me = await client.get("/api/me", headers={"Authorization": f"Session {token}"})
    assert me.status_code == 200


async def test_browser_login_unchanged(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=ALICE)
    client.cookies.clear()

    resp = await client.post("/api/auth/login", json=ALICE)

    assert "session" in resp.cookies
    assert resp.json()["session_token"] is None
    # браузерная кука недоступна скриптам страницы — иначе токен в куке
    # ничем не лучше токена в теле
    set_cookie = resp.headers["set-cookie"]
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie


async def test_browser_register_does_not_return_token(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/register", json=ALICE)

    assert resp.status_code == 201
    assert resp.json()["session_token"] is None
    assert "session" in resp.cookies


async def test_app_register_returns_token(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/register", json={**ALICE, "client": "app"})

    assert resp.status_code == 201
    token = resp.json()["session_token"]
    assert token
    assert "session" not in resp.cookies
    me = await client.get("/api/me", headers={"Authorization": f"Session {token}"})
    assert me.status_code == 200


async def test_unknown_client_rejected(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/login", json={**ALICE, "client": "bot"})
    assert resp.status_code == 422


async def test_preflight_from_app_allowed(client: AsyncClient) -> None:
    resp = await client.options(
        "/api/auth/login",
        headers={
            "Origin": TAURI_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == TAURI_ORIGIN
    # приложение ходит без cookie: разрешать странице слать их cross-origin незачем
    assert "access-control-allow-credentials" not in resp.headers


async def test_preflight_from_foreign_origin_not_allowed(client: AsyncClient) -> None:
    async def preflight(origin: str) -> Response:
        return await client.options(
            "/api/auth/login",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
        )

    # без парного опыта тест зелёный и там, где CORS не подключён вовсе
    assert "access-control-allow-origin" in (await preflight(TAURI_ORIGIN)).headers
    foreign = await preflight("https://evil.example")
    assert foreign.status_code == 400
    assert "access-control-allow-origin" not in foreign.headers


async def test_app_origin_passes_origin_check(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/register",
        json={**ALICE, "client": "app"},
        headers={"Origin": TAURI_ORIGIN},
    )
    assert resp.status_code == 201
