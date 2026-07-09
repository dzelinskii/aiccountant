import uuid
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import service

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _bootstrap(client: AsyncClient) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    reg = await client.post("/api/auth/register", json=ALICE)
    user_id = uuid.UUID(reg.json()["id"])
    me = await client.get("/api/me")
    ws = uuid.UUID(me.json()["workspaces"][0]["id"])
    acc = uuid.UUID(
        (
            await client.post(
                "/api/accounts",
                params={"workspace_id": str(ws)},
                json={"name": "Карта", "type": "card", "currency": "RUB"},
            )
        ).json()["id"]
    )
    return user_id, ws, acc


async def test_new_transaction_has_categorization_defaults(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    txn = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
    )
    await db_session.commit()
    assert txn.category_confirmed is False
    assert txn.category_confidence is None
    assert txn.suggested_category_id is None
