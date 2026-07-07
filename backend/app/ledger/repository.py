import uuid
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
