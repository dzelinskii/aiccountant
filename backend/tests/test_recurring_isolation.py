from datetime import date

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.recurring import service

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _register_ws(client: AsyncClient, creds: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


async def _rule_for_alice(client: AsyncClient) -> dict[str, str]:
    ws = await _register_ws(client, ALICE)
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    rent = next(c for c in cats if c["name"] == "Жильё")
    rule = (
        await client.post(
            "/api/recurring",
            params={"workspace_id": ws},
            json={
                "account_id": acc["id"],
                "category_id": rent["id"],
                "amount": "-30000.00",
                "period": "month",
                "interval": 1,
                "anchor_day": 5,
                "start_date": "2026-01-05",
                "mode": "remind",
            },
        )
    ).json()
    return {"ws": ws, "rule": rule["id"]}


async def test_non_member_cannot_read_or_delete_foreign_rule(client: AsyncClient) -> None:
    a = await _rule_for_alice(client)

    client.cookies.clear()
    ws_b = await _register_ws(client, BOB)

    # чужой workspace_id → 403 (не участник)
    assert (await client.get("/api/recurring", params={"workspace_id": a["ws"]})).status_code == 403
    # чужое правило под своим workspace → 404
    assert (
        await client.delete(f"/api/recurring/{a['rule']}", params={"workspace_id": ws_b})
    ).status_code == 404
    assert (
        await client.patch(
            f"/api/recurring/{a['rule']}", params={"workspace_id": ws_b}, json={"is_active": False}
        )
    ).status_code == 404


async def test_non_member_cannot_touch_foreign_occurrence(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    a = await _rule_for_alice(client)
    await service.process_due_rules(db_session, date(2026, 7, 20))
    occ = (await client.get("/api/recurring/occurrences", params={"workspace_id": a["ws"]})).json()
    occ_id = occ[0]["id"]

    client.cookies.clear()
    ws_b = await _register_ws(client, BOB)
    assert (
        await client.post(
            f"/api/recurring/occurrences/{occ_id}/confirm", params={"workspace_id": ws_b}, json={}
        )
    ).status_code == 404
    assert (
        await client.post(
            f"/api/recurring/occurrences/{occ_id}/skip", params={"workspace_id": ws_b}
        )
    ).status_code == 404
