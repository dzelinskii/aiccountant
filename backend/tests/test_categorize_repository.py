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


async def test_list_uncategorized_excludes_categorized_suggested_and_transfers(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food = next(c for c in cats if c.name == "Еда")

    # без категории — попадёт
    plain = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-10.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        merchant="Пятёрочка",
    )
    # уже с категорией — не попадёт
    await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=food.id,
        amount=Decimal("-20.00"),
        occurred_at=date(2026, 7, 5),
        source="manual",
    )
    # с активной подсказкой — не попадёт
    suggested = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-30.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
    )
    suggested.suggested_category_id = food.id
    await db_session.commit()

    rows = await repository.list_uncategorized(db_session, ws)
    ids = {t.id for t in rows}
    assert plain.id in ids
    assert suggested.id not in ids
    assert len(ids) == 1


async def test_recent_confirmed_pairs_only_confirmed_matching_kind(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food = next(c for c in cats if c.name == "Еда")
    salary = next(c for c in cats if c.name == "Зарплата")

    confirmed = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=food.id,
        amount=Decimal("-40.00"),
        occurred_at=date(2026, 7, 5),
        source="manual",
        merchant="Магнит",
    )
    confirmed.category_confirmed = True
    # income-подтверждённая — не должна попасть в expense-few-shot
    inc = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=salary.id,
        amount=Decimal("1000.00"),
        occurred_at=date(2026, 7, 5),
        source="manual",
        merchant="ООО Ромашка",
    )
    inc.category_confirmed = True
    await db_session.commit()

    pairs = await repository.recent_confirmed_pairs(db_session, ws, "expense", 10)
    assert ("Магнит", "Еда") in pairs
    assert all(name != "Зарплата" for _, name in pairs)
