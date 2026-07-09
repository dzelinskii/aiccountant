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
    DashboardAccount,
    DashboardOut,
    MonthExpense,
    RecentTransaction,
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
    # родитель обязан жить в том же workspace — иначе межворкспейсная ссылка
    if payload.parent_id is not None:
        parent = await repository.get_category(db, workspace_id, payload.parent_id)
        if parent is None:
            raise NotFoundError
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
        parent = await repository.get_category(db, workspace_id, payload.parent_id)
        if parent is None:
            raise NotFoundError
        category.parent_id = payload.parent_id
    await db.commit()
    return category


class SignMismatchError(Exception):
    """Знак суммы не соответствует kind категории."""


class InvalidTransferError(Exception):
    """Некорректный перевод (одинаковые счета, чужой счёт и т.п.)."""


class TransferEditError(Exception):
    """Строку перевода нельзя править — только удалить и создать заново."""


async def validate_posting(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    account_id: uuid.UUID,
    category_id: uuid.UUID | None,
    amount: Decimal,
) -> Account:
    """Проверить счёт (workspace) и, если категория задана, соответствие её kind
    знаку суммы. Категория опциональна; знак ≠ 0 требуется всегда."""
    account = await repository.get_account(db, workspace_id, account_id)
    if account is None:
        raise NotFoundError
    if amount == 0:
        raise SignMismatchError
    if category_id is not None:
        category = await repository.get_category(db, workspace_id, category_id)
        if category is None:
            raise NotFoundError
        if (category.kind == "expense") != (amount < 0):
            raise SignMismatchError
    return account


async def post_transaction(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    account_id: uuid.UUID,
    category_id: uuid.UUID | None,
    amount: Decimal,
    occurred_at: date,
    source: str,
    merchant: str | None = None,
    note: str | None = None,
    external_id: str | None = None,
    import_id: uuid.UUID | None = None,
) -> Transaction:
    """Провести обычную операцию (расход/доход) без commit — для переиспользования
    ручным вводом, регуляркой и импортом выписок."""
    account = await validate_posting(
        db, workspace_id, account_id=account_id, category_id=category_id, amount=amount
    )

    transaction = Transaction(
        workspace_id=workspace_id,
        account_id=account.id,
        category_id=category_id,
        amount=amount,
        currency=account.currency,
        occurred_at=occurred_at,
        merchant=merchant,
        note=note,
        source=source,
        created_by=user_id,
        external_id=external_id,
        import_id=import_id,
    )
    repository.add_transaction(db, transaction)
    await db.flush()
    return transaction


async def existing_external_ids(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID, external_ids: set[str]
) -> set[str]:
    return await repository.existing_external_ids(db, workspace_id, account_id, external_ids)


async def account_exists(db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID) -> bool:
    return await repository.get_account(db, workspace_id, account_id) is not None


async def create_transaction(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, payload: TransactionCreate
) -> Transaction:
    transaction = await post_transaction(
        db,
        workspace_id,
        user_id,
        account_id=payload.account_id,
        category_id=payload.category_id,
        amount=payload.amount,
        occurred_at=payload.occurred_at,
        source="manual",
        merchant=payload.merchant,
        note=payload.note,
    )
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

    # инвариант «знак суммы соответствует kind категории» проверяем всегда по
    # ИТОГОВой паре после правки, даже если меняется только сумма или только
    # категория — иначе расход можно было бы сделать положительным
    new_category_id = (
        payload.category_id if payload.category_id is not None else transaction.category_id
    )
    new_amount = payload.amount if payload.amount is not None else transaction.amount
    if new_amount == 0:
        raise SignMismatchError
    if new_category_id is not None:
        category = await repository.get_category(db, workspace_id, new_category_id)
        if category is None:
            raise NotFoundError
        if (category.kind == "expense") != (new_amount < 0):
            raise SignMismatchError

    transaction.category_id = new_category_id
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


async def build_dashboard(db: AsyncSession, workspace_id: uuid.UUID) -> DashboardOut:
    today = date.today()
    month_start = today.replace(day=1)
    # начало следующего месяца — верхняя граница периода (полуинтервал)
    next_month_start = (
        month_start.replace(year=month_start.year + 1, month=1)
        if month_start.month == 12
        else month_start.replace(month=month_start.month + 1)
    )

    accounts = await repository.list_accounts_with_balance(db, workspace_id)
    expenses = await repository.month_expenses_by_category(
        db, workspace_id, month_start, next_month_start
    )
    recent = await repository.recent_transactions(db, workspace_id)

    return DashboardOut(
        accounts=[
            DashboardAccount(id=a.id, name=a.name, currency=a.currency, balance=bal)
            for a, bal in accounts
        ],
        month_expenses=[
            MonthExpense(category_id=cid, category_name=name or "Без категории", total=total)
            for cid, name, total in expenses
        ],
        recent=[
            RecentTransaction(
                id=t.id,
                occurred_at=t.occurred_at,
                amount=t.amount,
                currency=t.currency,
                account_name=acc_name,
                category_name=cat_name,
                merchant=t.merchant,
                is_transfer=t.transfer_group_id is not None,
            )
            for t, acc_name, cat_name in recent
        ],
    )
