import uuid
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger.models import Account, Transaction


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
