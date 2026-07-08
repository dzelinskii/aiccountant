import uuid
from datetime import date

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.recurring.models import RecurringOccurrence, RecurringRule


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


async def due_rules(db: AsyncSession, today: date) -> list[RecurringRule]:
    rows = await db.execute(
        select(RecurringRule).where(
            RecurringRule.is_active.is_(True),
            RecurringRule.next_run_at <= today,
            or_(
                RecurringRule.end_date.is_(None),
                RecurringRule.next_run_at <= RecurringRule.end_date,
            ),
        )
    )
    return list(rows.scalars().all())


async def occurrence_exists(db: AsyncSession, rule_id: uuid.UUID, due_date: date) -> bool:
    found = await db.scalar(
        select(RecurringOccurrence.id).where(
            RecurringOccurrence.rule_id == rule_id, RecurringOccurrence.due_date == due_date
        )
    )
    return found is not None


def add_occurrence(db: AsyncSession, occurrence: RecurringOccurrence) -> None:
    db.add(occurrence)


async def list_occurrences(
    db: AsyncSession, workspace_id: uuid.UUID, status: str
) -> list[RecurringOccurrence]:
    rows = await db.execute(
        select(RecurringOccurrence)
        .where(
            RecurringOccurrence.workspace_id == workspace_id,
            RecurringOccurrence.status == status,
        )
        .order_by(RecurringOccurrence.due_date)
    )
    return list(rows.scalars().all())


async def get_occurrence(
    db: AsyncSession, workspace_id: uuid.UUID, occurrence_id: uuid.UUID
) -> RecurringOccurrence | None:
    result: RecurringOccurrence | None = await db.scalar(
        select(RecurringOccurrence).where(
            RecurringOccurrence.id == occurrence_id,
            RecurringOccurrence.workspace_id == workspace_id,
        )
    )
    return result
