import uuid
from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.money import MoneyStr

PERIODS = "^(day|week|month|year)$"
MODES = "^(autopost|remind)$"


class RuleCreate(BaseModel):
    account_id: uuid.UUID
    category_id: uuid.UUID | None = None
    amount: Decimal
    period: str = Field(pattern=PERIODS)
    interval: int = Field(ge=1)
    anchor_day: int | None = Field(default=None, ge=1, le=31)
    start_date: date
    mode: str = Field(pattern=MODES)
    end_date: date | None = None
    note: str | None = Field(default=None, max_length=1000)


class RuleUpdate(BaseModel):
    amount: Decimal | None = None
    interval: int | None = Field(default=None, ge=1)
    anchor_day: int | None = Field(default=None, ge=1, le=31)
    mode: str | None = Field(default=None, pattern=MODES)
    is_active: bool | None = None
    end_date: date | None = None
    note: str | None = Field(default=None, max_length=1000)


class RuleOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    category_id: uuid.UUID | None
    amount: MoneyStr
    currency: str
    period: str
    interval: int
    anchor_day: int | None
    start_date: date
    next_run_at: date
    mode: str
    is_active: bool
    end_date: date | None
    note: str | None


class OccurrenceOut(BaseModel):
    id: uuid.UUID
    rule_id: uuid.UUID
    due_date: date
    amount: MoneyStr
    status: str
    transaction_id: uuid.UUID | None


class OccurrenceConfirm(BaseModel):
    amount: Decimal | None = None
