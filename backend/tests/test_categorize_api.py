import uuid
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository, service

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


async def test_transaction_out_exposes_categorization_fields(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")
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
    txn.suggested_category_id = food_id
    txn.category_confidence = Decimal("0.400")
    await db_session.commit()

    resp = await client.get("/api/transactions", params={"workspace_id": str(ws)})
    item = resp.json()["items"][0]
    assert item["category_confirmed"] is False
    assert item["suggested_category_id"] == str(food_id)
    assert item["category_confidence"] == "0.400"


async def test_patch_category_confirms_and_clears_suggestion(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")
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
    txn.suggested_category_id = food_id
    await db_session.commit()

    resp = await client.patch(
        f"/api/transactions/{txn.id}",
        params={"workspace_id": str(ws)},
        json={"category_id": str(food_id)},
    )
    assert resp.status_code == 200
    await db_session.refresh(txn)
    assert txn.category_id == food_id
    assert txn.category_confirmed is True
    assert txn.suggested_category_id is None


async def test_dismiss_suggestion_clears_it(client: AsyncClient, db_session: AsyncSession) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")
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
    txn.suggested_category_id = food_id
    await db_session.commit()

    resp = await client.post(
        f"/api/transactions/{txn.id}/dismiss-suggestion",
        params={"workspace_id": str(ws)},
    )
    assert resp.status_code == 200
    await db_session.refresh(txn)
    assert txn.suggested_category_id is None
    assert txn.category_id is None


async def test_dismissed_suggestion_not_recategorized(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")
    txn = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        merchant="Пятёрочка",
    )
    txn.suggested_category_id = food_id
    await db_session.commit()

    await service.dismiss_suggestion(db_session, ws, txn.id)
    await db_session.refresh(txn)
    # dismiss = решение человека: операция остаётся без категории и больше не кандидат
    assert txn.category_id is None
    assert txn.category_confirmed is True
    rows = await repository.list_uncategorized(db_session, ws)
    assert txn.id not in {t.id for t in rows}
