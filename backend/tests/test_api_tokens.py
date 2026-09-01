from httpx import AsyncClient

from app.identity.tokens import generate_token, hash_token

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _register(client: AsyncClient, creds: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


async def _ws(client: AsyncClient) -> str:
    return await _register(client, ALICE)


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
    """C1: токен, выданный в workspace Алисы, не открывает другой workspace,
    даже такой, участником которого Алиса легально является."""
    alice_ws = await _register(client, ALICE)
    client.cookies.clear()
    bob_ws = await _register(client, BOB)
    await client.post(f"/api/workspaces/{bob_ws}/members", json={"email": ALICE["email"]})

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    token = (
        await client.post("/api/tokens", params={"workspace_id": alice_ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()
    resp = await client.get(
        "/api/accounts",
        params={"workspace_id": bob_ws},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


async def test_token_cannot_create_token(client: AsyncClient) -> None:
    """C2: утёкший токен не должен уметь выпускать себе замену — иначе отзыв
    исходного токена ничего не даёт."""
    ws = await _ws(client)
    token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()
    resp = await client.post(
        "/api/tokens",
        params={"workspace_id": ws},
        json={"name": "новый"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


async def test_token_cannot_add_member(client: AsyncClient) -> None:
    """C2: машинный токен не должен выполнять owner-действия."""
    ws = await _ws(client)
    token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()
    resp = await client.post(
        f"/api/workspaces/{ws}/members",
        json={"email": "ghost@example.com"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


async def test_list_tokens_filtered_by_workspace(client: AsyncClient) -> None:
    """I3: чужой workspace_id не должен показывать токены другого пользователя."""
    alice_ws = await _register(client, ALICE)
    await client.post("/api/tokens", params={"workspace_id": alice_ws}, json={"name": "алисин"})

    client.cookies.clear()
    bob_ws = await _register(client, BOB)
    listed = await client.get("/api/tokens", params={"workspace_id": bob_ws})
    assert listed.status_code == 200
    assert listed.json() == []


async def test_revoke_foreign_workspace_token_not_found(client: AsyncClient) -> None:
    """I3: чужой workspace_id не должен позволять отозвать чужой токен по id."""
    alice_ws = await _register(client, ALICE)
    alice_token_id = (
        await client.post("/api/tokens", params={"workspace_id": alice_ws}, json={"name": "алисин"})
    ).json()["id"]

    client.cookies.clear()
    bob_ws = await _register(client, BOB)
    resp = await client.delete(f"/api/tokens/{alice_token_id}", params={"workspace_id": bob_ws})
    assert resp.status_code == 404


async def test_empty_bearer_header_rejected_even_with_valid_session(client: AsyncClient) -> None:
    """Заголовок присутствует — он и решает: с плохим заголовком запрос не
    должен молча откатываться на действующую куку."""
    ws = await _ws(client)
    resp = await client.get(
        "/api/accounts", params={"workspace_id": ws}, headers={"Authorization": "Bearer"}
    )
    assert resp.status_code == 401


async def test_lowercase_bearer_scheme_is_accepted(client: AsyncClient) -> None:
    ws = await _ws(client)
    token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()
    resp = await client.get(
        "/api/accounts", params={"workspace_id": ws}, headers={"Authorization": f"bearer {token}"}
    )
    assert resp.status_code == 200


async def test_revoking_twice_returns_404(client: AsyncClient) -> None:
    ws = await _ws(client)
    created = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()
    first = await client.delete(f"/api/tokens/{created['id']}", params={"workspace_id": ws})
    assert first.status_code == 204
    second = await client.delete(f"/api/tokens/{created['id']}", params={"workspace_id": ws})
    assert second.status_code == 404


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
