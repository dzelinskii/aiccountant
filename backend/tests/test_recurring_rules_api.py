from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _setup(client: AsyncClient) -> dict[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    rent = next(c for c in cats if c["name"] == "Жильё")
    return {"ws": ws, "acc": acc["id"], "rent": rent["id"]}


def _rule(s: dict[str, str], **over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "account_id": s["acc"],
        "category_id": s["rent"],
        "amount": "-30000.00",
        "period": "month",
        "interval": 1,
        "anchor_day": 5,
        "start_date": "2026-07-05",
        "mode": "autopost",
    }
    base.update(over)
    return base


async def test_create_and_list_rule(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post("/api/recurring", params={"workspace_id": s["ws"]}, json=_rule(s))
    assert resp.status_code == 201
    body = resp.json()
    assert body["currency"] == "RUB"
    assert body["next_run_at"] == "2026-07-05"
    assert body["amount"] == "-30000.0000"

    lst = await client.get("/api/recurring", params={"workspace_id": s["ws"]})
    assert lst.status_code == 200
    assert len(lst.json()) == 1


async def test_sign_must_match_kind(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/recurring", params={"workspace_id": s["ws"]}, json=_rule(s, amount="30000.00")
    )  # расход должен быть отрицательным
    assert resp.status_code == 422


async def test_month_requires_anchor_day(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/recurring", params={"workspace_id": s["ws"]}, json=_rule(s, anchor_day=None)
    )
    assert resp.status_code == 422


async def test_update_deactivate_and_delete(client: AsyncClient) -> None:
    s = await _setup(client)
    rule = (
        await client.post("/api/recurring", params={"workspace_id": s["ws"]}, json=_rule(s))
    ).json()

    patched = await client.patch(
        f"/api/recurring/{rule['id']}", params={"workspace_id": s["ws"]}, json={"is_active": False}
    )
    assert patched.status_code == 200
    assert patched.json()["is_active"] is False

    deleted = await client.delete(f"/api/recurring/{rule['id']}", params={"workspace_id": s["ws"]})
    assert deleted.status_code == 204
    assert len((await client.get("/api/recurring", params={"workspace_id": s["ws"]})).json()) == 0


async def test_rule_without_category(client: AsyncClient) -> None:
    s = await _setup(client)
    body = _rule(s)
    del body["category_id"]
    resp = await client.post("/api/recurring", params={"workspace_id": s["ws"]}, json=body)
    assert resp.status_code == 201
    assert resp.json()["category_id"] is None
