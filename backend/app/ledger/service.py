import uuid
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository
from app.ledger.models import Account, Category
from app.ledger.schemas import AccountCreate, AccountUpdate, CategoryCreate, CategoryUpdate


class NotFoundError(Exception):
    pass


async def list_accounts(db: AsyncSession, workspace_id: uuid.UUID) -> list[tuple[Account, Decimal]]:
    return await repository.list_accounts_with_balance(db, workspace_id)


async def create_account(
    db: AsyncSession, workspace_id: uuid.UUID, payload: AccountCreate
) -> tuple[Account, Decimal]:
    account = Account(
        workspace_id=workspace_id,
        name=payload.name,
        type=payload.type,
        currency=payload.currency,
    )
    repository.add_account(db, account)
    await db.commit()
    return account, Decimal(0)


async def update_account(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID, payload: AccountUpdate
) -> tuple[Account, Decimal]:
    account = await repository.get_account(db, workspace_id, account_id)
    if account is None:
        raise NotFoundError
    if payload.name is not None:
        account.name = payload.name
    if payload.is_archived is not None:
        account.is_archived = payload.is_archived
    await db.commit()
    balance = await repository.account_balance(db, workspace_id, account_id)
    return account, balance


async def seed_categories(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    repository.seed_default_categories(db, workspace_id)
    await db.commit()


async def list_categories(db: AsyncSession, workspace_id: uuid.UUID) -> list[Category]:
    return await repository.list_categories(db, workspace_id)


async def create_category(
    db: AsyncSession, workspace_id: uuid.UUID, payload: CategoryCreate
) -> Category:
    category = Category(
        workspace_id=workspace_id,
        name=payload.name,
        kind=payload.kind,
        parent_id=payload.parent_id,
    )
    repository.add_category(db, category)
    await db.commit()
    return category


async def update_category(
    db: AsyncSession, workspace_id: uuid.UUID, category_id: uuid.UUID, payload: CategoryUpdate
) -> Category:
    category = await repository.get_category(db, workspace_id, category_id)
    if category is None:
        raise NotFoundError
    if payload.name is not None:
        category.name = payload.name
    if payload.parent_id is not None:
        category.parent_id = payload.parent_id
    await db.commit()
    return category
