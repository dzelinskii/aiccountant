import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository
from app.ledger.models import Account, Category, Transaction
from app.ledger.schemas import (
    AccountCreate,
    AccountUpdate,
    CategoryCreate,
    CategoryUpdate,
    TransactionCreate,
    TransactionUpdate,
    TransferCreate,
)


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


class SignMismatchError(Exception):
    """Знак суммы не соответствует kind категории."""


class InvalidTransferError(Exception):
    """Некорректный перевод (одинаковые счета, чужой счёт и т.п.)."""


class TransferEditError(Exception):
    """Строку перевода нельзя править — только удалить и создать заново."""


async def create_transaction(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, payload: TransactionCreate
) -> Transaction:
    account = await repository.get_account(db, workspace_id, payload.account_id)
    if account is None:
        raise NotFoundError
    category = await repository.get_category(db, workspace_id, payload.category_id)
    if category is None:
        raise NotFoundError
    if payload.amount == 0:
        raise SignMismatchError
    if category.kind == "expense" and payload.amount > 0:
        raise SignMismatchError
    if category.kind == "income" and payload.amount < 0:
        raise SignMismatchError

    transaction = Transaction(
        workspace_id=workspace_id,
        account_id=account.id,
        category_id=category.id,
        amount=payload.amount,
        currency=account.currency,
        occurred_at=payload.occurred_at,
        merchant=payload.merchant,
        note=payload.note,
        source="manual",
        created_by=user_id,
    )
    repository.add_transaction(db, transaction)
    await db.commit()
    return transaction


async def create_transfer(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, payload: TransferCreate
) -> list[Transaction]:
    if payload.from_account_id == payload.to_account_id:
        raise InvalidTransferError
    src = await repository.get_account(db, workspace_id, payload.from_account_id)
    dst = await repository.get_account(db, workspace_id, payload.to_account_id)
    if src is None or dst is None:
        raise InvalidTransferError

    group_id = uuid.uuid4()
    outflow = Transaction(
        workspace_id=workspace_id,
        account_id=src.id,
        category_id=None,
        amount=-payload.from_amount,
        currency=src.currency,
        occurred_at=payload.occurred_at,
        note=payload.note,
        source="manual",
        transfer_group_id=group_id,
        created_by=user_id,
    )
    inflow = Transaction(
        workspace_id=workspace_id,
        account_id=dst.id,
        category_id=None,
        amount=payload.to_amount,
        currency=dst.currency,
        occurred_at=payload.occurred_at,
        note=payload.note,
        source="manual",
        transfer_group_id=group_id,
        created_by=user_id,
    )
    repository.add_transaction(db, outflow)
    repository.add_transaction(db, inflow)
    await db.commit()  # обе строки или ни одной — один commit
    return [outflow, inflow]


async def update_transaction(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    transaction_id: uuid.UUID,
    payload: TransactionUpdate,
) -> Transaction:
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    if transaction.transfer_group_id is not None:
        raise TransferEditError
    if payload.category_id is not None:
        category = await repository.get_category(db, workspace_id, payload.category_id)
        if category is None:
            raise NotFoundError
        new_amount = payload.amount if payload.amount is not None else transaction.amount
        if new_amount == 0 or (category.kind == "expense") != (new_amount < 0):
            raise SignMismatchError
        transaction.category_id = category.id
    if payload.amount is not None:
        transaction.amount = payload.amount
    if payload.occurred_at is not None:
        transaction.occurred_at = payload.occurred_at
    if payload.merchant is not None:
        transaction.merchant = payload.merchant
    if payload.note is not None:
        transaction.note = payload.note
    await db.commit()
    return transaction


async def delete_transaction(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> None:
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    if transaction.transfer_group_id is not None:
        group = await repository.get_transfer_group(db, workspace_id, transaction.transfer_group_id)
        for row in group:
            await repository.delete_transaction(db, row)
    else:
        await repository.delete_transaction(db, transaction)
    await db.commit()  # обе строки перевода удаляются атомарно


async def list_transactions(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    account_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Transaction], int]:
    return await repository.list_transactions(
        db,
        workspace_id,
        account_id=account_id,
        category_id=category_id,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    )
