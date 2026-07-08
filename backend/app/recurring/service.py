import uuid
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import service as ledger_service
from app.recurring import repository
from app.recurring.models import RecurringRule
from app.recurring.schedule import compute_initial_next_run, next_run_from
from app.recurring.schemas import RuleCreate, RuleUpdate


class NotFoundError(Exception):
    pass


class SignMismatchError(Exception):
    """Знак суммы не соответствует kind категории."""


class RuleValidationError(Exception):
    """Некорректные параметры правила (например month без anchor_day)."""


class OccurrenceStateError(Exception):
    """Действие недопустимо в текущем статусе срабатывания."""


async def _validate(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    category_id: uuid.UUID,
    amount: Decimal,
) -> object:
    # переводим доменные ошибки ledger в словарь recurring (граница модуля)
    try:
        return await ledger_service.validate_posting(
            db, workspace_id, account_id=account_id, category_id=category_id, amount=amount
        )
    except ledger_service.NotFoundError:
        raise NotFoundError from None
    except ledger_service.SignMismatchError:
        raise SignMismatchError from None


async def list_rules(db: AsyncSession, workspace_id: uuid.UUID) -> list[RecurringRule]:
    return await repository.list_rules(db, workspace_id)


async def create_rule(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, payload: RuleCreate
) -> RecurringRule:
    if payload.period == "month" and payload.anchor_day is None:
        raise RuleValidationError
    account = await _validate(
        db, workspace_id, payload.account_id, payload.category_id, payload.amount
    )
    next_run = compute_initial_next_run(
        payload.period, payload.interval, payload.anchor_day, payload.start_date
    )
    rule = RecurringRule(
        workspace_id=workspace_id,
        account_id=payload.account_id,
        category_id=payload.category_id,
        amount=payload.amount,
        currency=account.currency,  # type: ignore[attr-defined]
        period=payload.period,
        interval=payload.interval,
        anchor_day=payload.anchor_day,
        start_date=payload.start_date,
        next_run_at=next_run,
        mode=payload.mode,
        is_active=True,
        end_date=payload.end_date,
        note=payload.note,
        created_by=user_id,
    )
    repository.add_rule(db, rule)
    await db.commit()
    return rule


async def update_rule(
    db: AsyncSession, workspace_id: uuid.UUID, rule_id: uuid.UUID, payload: RuleUpdate
) -> RecurringRule:
    rule = await repository.get_rule(db, workspace_id, rule_id)
    if rule is None:
        raise NotFoundError
    if payload.amount is not None:
        await _validate(db, workspace_id, rule.account_id, rule.category_id, payload.amount)
        rule.amount = payload.amount
    if payload.mode is not None:
        rule.mode = payload.mode
    if payload.is_active is not None:
        rule.is_active = payload.is_active
    if payload.end_date is not None:
        rule.end_date = payload.end_date
    if payload.note is not None:
        rule.note = payload.note
    # при изменении шага/якоря пересчитываем ближайший будущий слот от start_date
    if payload.interval is not None or payload.anchor_day is not None:
        if payload.interval is not None:
            rule.interval = payload.interval
        if payload.anchor_day is not None:
            rule.anchor_day = payload.anchor_day
        rule.next_run_at = next_run_from(
            rule.period,
            rule.interval,
            rule.anchor_day,
            rule.start_date,
            after=date.today() - timedelta(days=1),
        )
    await db.commit()
    return rule


async def delete_rule(db: AsyncSession, workspace_id: uuid.UUID, rule_id: uuid.UUID) -> None:
    rule = await repository.get_rule(db, workspace_id, rule_id)
    if rule is None:
        raise NotFoundError
    await repository.delete_rule(db, rule)
    await db.commit()
