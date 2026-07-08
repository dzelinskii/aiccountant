from datetime import date

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.recurring import service

ALICE = {"email": "alice@example.com", "password": "password123"}
TODAY = date(2026, 7, 20)


async def _remind_occurrence(client: AsyncClient, db_session: AsyncSession) -> dict[str, str]:
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
    util = next(c for c in cats if c["name"] == "Связь")
    await client.post(
        "/api/recurring",
        params={"workspace_id": ws},
        json={
            "account_id": acc["id"],
            "category_id": util["id"],
            "amount": "-800.00",
            "period": "month",
            "interval": 1,
            "anchor_day": 5,
            "start_date": "2026-01-05",
            "mode": "remind",
        },
    )
    await service.process_due_rules(db_session, TODAY)
    occ = (await client.get("/api/recurring/occurrences", params={"workspace_id": ws})).json()
    return {"ws": ws, "occ": occ[0]["id"]}


async def test_pending_listed(client: AsyncClient, db_session: AsyncSession) -> None:
    s = await _remind_occurrence(client, db_session)
    occ = (
        await client.get(
            "/api/recurring/occurrences", params={"workspace_id": s["ws"], "status": "pending"}
        )
    ).json()
    assert len(occ) == 1
    assert occ[0]["status"] == "pending"


async def test_confirm_creates_transaction_with_adjusted_amount(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    s = await _remind_occurrence(client, db_session)
    resp = await client.post(
        f"/api/recurring/occurrences/{s['occ']}/confirm",
        params={"workspace_id": s["ws"]},
        json={"amount": "-950.00"},
    )  # ЖКХ: сумма уточнена
    assert resp.status_code == 201
    assert resp.json()["status"] == "confirmed"

    txns = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    assert txns["total"] == 1
    assert txns["items"][0]["amount"] == "-950.0000"

    # уже не pending — повторный confirm → 409
    again = await client.post(
        f"/api/recurring/occurrences/{s['occ']}/confirm", params={"workspace_id": s["ws"]}, json={}
    )
    assert again.status_code == 409


async def test_skip_marks_skipped_no_transaction(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    s = await _remind_occurrence(client, db_session)
    resp = await client.post(
        f"/api/recurring/occurrences/{s['occ']}/skip", params={"workspace_id": s["ws"]}
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "skipped"
    txns = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    assert txns["total"] == 0


async def test_confirm_wrong_sign_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    s = await _remind_occurrence(client, db_session)
    resp = await client.post(
        f"/api/recurring/occurrences/{s['occ']}/confirm",
        params={"workspace_id": s["ws"]},
        json={"amount": "800.00"},
    )  # расход не может быть +
    assert resp.status_code == 422
