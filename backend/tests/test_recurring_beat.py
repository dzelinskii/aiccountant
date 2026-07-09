from datetime import date

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.recurring import service
from app.recurring.models import RecurringOccurrence

ALICE = {"email": "alice@example.com", "password": "password123"}
TODAY = date(2026, 7, 20)


async def _setup_rule(
    client: AsyncClient,
    *,
    mode: str,
    amount: str = "-30000.00",
    start: str = "2026-01-05",
    active: bool = True,
    end_date: str | None = None,
) -> dict[str, str]:
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
    rule = (
        await client.post(
            "/api/recurring",
            params={"workspace_id": ws},
            json={
                "account_id": acc["id"],
                "category_id": rent["id"],
                "amount": amount,
                "period": "month",
                "interval": 1,
                "anchor_day": 5,
                "start_date": start,
                "mode": mode,
                **({"end_date": end_date} if end_date else {}),
            },
        )
    ).json()
    if not active:
        await client.patch(
            f"/api/recurring/{rule['id']}", params={"workspace_id": ws}, json={"is_active": False}
        )
    return {"ws": ws, "rule": rule["id"]}


async def _occurrences(db: AsyncSession, ws: str) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(RecurringOccurrence)
            .where(RecurringOccurrence.workspace_id == ws)
        )
        or 0
    )


async def test_autopost_creates_transaction_and_advances(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    s = await _setup_rule(client, mode="autopost")
    processed = await service.process_due_rules(db_session, TODAY)
    assert processed == 1

    txns = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    assert txns["total"] == 1
    assert txns["items"][0]["amount"] == "-30000.0000"

    rules = (await client.get("/api/recurring", params={"workspace_id": s["ws"]})).json()
    assert rules[0]["next_run_at"] > TODAY.isoformat()  # перескок в будущее
    assert await _occurrences(db_session, s["ws"]) == 1


async def test_remind_creates_pending_without_transaction(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    s = await _setup_rule(client, mode="remind")
    await service.process_due_rules(db_session, TODAY)
    txns = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    assert txns["total"] == 0
    assert await _occurrences(db_session, s["ws"]) == 1


async def test_double_scan_is_idempotent(client: AsyncClient, db_session: AsyncSession) -> None:
    s = await _setup_rule(client, mode="autopost")
    await service.process_due_rules(db_session, TODAY)
    await service.process_due_rules(db_session, TODAY)  # повторный тик
    assert await _occurrences(db_session, s["ws"]) == 1
    txns = (await client.get("/api/transactions", params={"workspace_id": s["ws"]})).json()
    assert txns["total"] == 1


async def test_inactive_and_ended_rules_skipped(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    s1 = await _setup_rule(client, mode="autopost", active=False)
    processed = await service.process_due_rules(db_session, TODAY)
    assert processed == 0
    assert await _occurrences(db_session, s1["ws"]) == 0


async def test_autopost_without_category(client: AsyncClient, db_session: AsyncSession) -> None:
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
    await client.post(
        "/api/recurring",
        params={"workspace_id": ws},
        json={
            "account_id": acc["id"],
            "amount": "-30000.00",
            "period": "month",
            "interval": 1,
            "anchor_day": 5,
            "start_date": "2026-01-05",
            "mode": "autopost",
        },
    )
    await service.process_due_rules(db_session, TODAY)
    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 1
    assert txns["items"][0]["category_id"] is None
