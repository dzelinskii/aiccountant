import uuid

from httpx import AsyncClient

from app.identity.tokens import generate_token, hash_token

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _ws(client: AsyncClient) -> str:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


async def test_create_token_returns_value_once(client: AsyncClient) -> None:
    ws = await _ws(client)
    resp = await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "коллектор"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["token"]  # сам токен отдаётся только здесь
    assert body["name"] == "коллектор"

    listed = await client.get("/api/tokens", params={"workspace_id": ws})
    assert listed.status_code == 200
    assert all("token" not in t for t in listed.json())  # больше никогда не показываем


async def test_token_authorizes_api_without_session(client: AsyncClient) -> None:
    ws = await _ws(client)
    token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()  # никакой сессии — только заголовок
    resp = await client.get(
        "/api/accounts", params={"workspace_id": ws}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200


async def test_revoked_token_is_rejected(client: AsyncClient) -> None:
    ws = await _ws(client)
    created = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()
    await client.delete(f"/api/tokens/{created['id']}", params={"workspace_id": ws})

    client.cookies.clear()
    resp = await client.get(
        "/api/accounts",
        params={"workspace_id": ws},
        headers={"Authorization": f"Bearer {created['token']}"},
    )
    assert resp.status_code == 401


async def test_garbage_token_is_rejected(client: AsyncClient) -> None:
    ws = await _ws(client)
    client.cookies.clear()
    resp = await client.get(
        "/api/accounts",
        params={"workspace_id": ws},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


async def test_token_does_not_open_foreign_workspace(client: AsyncClient) -> None:
    ws = await _ws(client)
    token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()
    resp = await client.get(
        "/api/accounts",
        params={"workspace_id": str(uuid.uuid4())},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code in (401, 403)


def test_generate_token_is_long_and_unique() -> None:
    a, b = generate_token(), generate_token()
    assert a != b
    # 32 байта в base64url — подбор невозможен, поэтому хеш может быть быстрым
    assert len(a) >= 43


def test_hash_token_is_deterministic_and_not_the_token() -> None:
    token = generate_token()
    assert hash_token(token) == hash_token(token)
    assert hash_token(token) != token
    assert len(hash_token(token)) == 64  # sha256 hex


def test_different_tokens_hash_differently() -> None:
    assert hash_token(generate_token()) != hash_token(generate_token())
