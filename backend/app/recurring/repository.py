import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.recurring.models import RecurringRule


async def list_rules(db: AsyncSession, workspace_id: uuid.UUID) -> list[RecurringRule]:
    rows = await db.execute(
        select(RecurringRule)
        .where(RecurringRule.workspace_id == workspace_id)
        .order_by(RecurringRule.created_at)
    )
    return list(rows.scalars().all())


async def get_rule(
    db: AsyncSession, workspace_id: uuid.UUID, rule_id: uuid.UUID
) -> RecurringRule | None:
    result: RecurringRule | None = await db.scalar(
        select(RecurringRule).where(
            RecurringRule.id == rule_id, RecurringRule.workspace_id == workspace_id
        )
    )
    return result


def add_rule(db: AsyncSession, rule: RecurringRule) -> None:
    db.add(rule)


async def delete_rule(db: AsyncSession, rule: RecurringRule) -> None:
    # occurrences уходят каскадом (FK ondelete=CASCADE); проведённые транзакции остаются
    await db.delete(rule)
