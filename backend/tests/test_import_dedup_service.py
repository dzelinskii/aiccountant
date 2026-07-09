import uuid
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import service

ALICE = {"email": "alice@example.com", "password": "password123"}


async def test_post_with_external_id_and_dedup_lookup(
    client: AsyncClient, db_session: AsyncSession
) -> None:
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

    txn = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        external_id="hash-1",
        import_id=uuid.uuid4(),
    )
    await db_session.commit()
    assert txn.external_id == "hash-1"
    assert txn.source == "import"
    assert txn.category_id is None

    found = await service.existing_external_ids(db_session, ws, acc, {"hash-1", "hash-2"})
    assert found == {"hash-1"}

    assert await service.account_exists(db_session, ws, acc) is True
    assert await service.account_exists(db_session, ws, uuid.uuid4()) is False
