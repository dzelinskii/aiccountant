import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger.models import Account, Category, Transaction


async def list_accounts_with_balance(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[Account, Decimal]]:
    balance = func.coalesce(func.sum(Transaction.amount), 0)
    stmt = (
        select(Account, balance)
        .outerjoin(Transaction, Transaction.account_id == Account.id)
        .where(Account.workspace_id == workspace_id)
        .group_by(Account.id)
        .order_by(Account.created_at)
    )
    rows = await db.execute(stmt)
    return [(acc, Decimal(bal)) for acc, bal in rows.all()]


async def get_account(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID
) -> Account | None:
    account: Account | None = await db.scalar(
        select(Account).where(Account.id == account_id, Account.workspace_id == workspace_id)
    )
    return account


async def account_balance(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID
) -> Decimal:
    stmt = select(func.coalesce(func.sum(Transaction.amount), 0)).where(
        Transaction.workspace_id == workspace_id, Transaction.account_id == account_id
    )
    return Decimal(await db.scalar(stmt) or 0)


def add_account(db: AsyncSession, account: Account) -> None:
    db.add(account)


# дефолтный набор при создании workspace (§3 спеки)
DEFAULT_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("Еда", "expense"),
    ("Транспорт", "expense"),
    ("Жильё", "expense"),
    ("Связь", "expense"),
    ("Развлечения", "expense"),
    ("Здоровье", "expense"),
    ("Прочее", "expense"),
    ("Зарплата", "income"),
    ("Прочие доходы", "income"),
)


async def list_categories(db: AsyncSession, workspace_id: uuid.UUID) -> list[Category]:
    rows = await db.execute(
        select(Category)
        .where(Category.workspace_id == workspace_id)
        .order_by(Category.kind, Category.name)
    )
    return list(rows.scalars().all())


async def get_category(
    db: AsyncSession, workspace_id: uuid.UUID, category_id: uuid.UUID
) -> Category | None:
    category: Category | None = await db.scalar(
        select(Category).where(Category.id == category_id, Category.workspace_id == workspace_id)
    )
    return category


def add_category(db: AsyncSession, category: Category) -> None:
    db.add(category)


def seed_default_categories(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    for name, kind in DEFAULT_CATEGORIES:
        db.add(Category(workspace_id=workspace_id, name=name, kind=kind))


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
    conditions = [Transaction.workspace_id == workspace_id]
    if account_id is not None:
        conditions.append(Transaction.account_id == account_id)
    if category_id is not None:
        conditions.append(Transaction.category_id == category_id)
    if date_from is not None:
        conditions.append(Transaction.occurred_at >= date_from)
    if date_to is not None:
        conditions.append(Transaction.occurred_at <= date_to)

    total = await db.scalar(select(func.count()).select_from(Transaction).where(*conditions))
    rows = await db.execute(
        select(Transaction)
        .where(*conditions)
        .order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(rows.scalars().all()), int(total or 0)


async def get_transaction(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> Transaction | None:
    result: Transaction | None = await db.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id, Transaction.workspace_id == workspace_id
        )
    )
    return result


async def get_transfer_group(
    db: AsyncSession, workspace_id: uuid.UUID, transfer_group_id: uuid.UUID
) -> list[Transaction]:
    rows = await db.execute(
        select(Transaction).where(
            Transaction.workspace_id == workspace_id,
            Transaction.transfer_group_id == transfer_group_id,
        )
    )
    return list(rows.scalars().all())


def add_transaction(db: AsyncSession, transaction: Transaction) -> None:
    db.add(transaction)


async def delete_transaction(db: AsyncSession, transaction: Transaction) -> None:
    await db.delete(transaction)


async def month_expenses_by_category(
    db: AsyncSession, workspace_id: uuid.UUID, month_start: date, next_month_start: date
) -> list[tuple[uuid.UUID, str, Decimal]]:
    total = func.sum(-Transaction.amount)
    rows = await db.execute(
        select(Category.id, Category.name, total)
        .join(Transaction, Transaction.category_id == Category.id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.amount < 0,
            Transaction.transfer_group_id.is_(None),
            Transaction.occurred_at >= month_start,
            Transaction.occurred_at < next_month_start,
        )
        .group_by(Category.id, Category.name)
        .order_by(total.desc())
    )
    return [(cid, name, Decimal(t)) for cid, name, t in rows.all()]


async def recent_transactions(
    db: AsyncSession, workspace_id: uuid.UUID, limit: int = 10
) -> list[tuple[Transaction, str, str | None]]:
    rows = await db.execute(
        select(Transaction, Account.name, Category.name)
        .join(Account, Account.id == Transaction.account_id)
        .outerjoin(Category, Category.id == Transaction.category_id)
        .where(Transaction.workspace_id == workspace_id)
        .order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
        .limit(limit)
    )
    return [(t, acc_name, cat_name) for t, acc_name, cat_name in rows.all()]
