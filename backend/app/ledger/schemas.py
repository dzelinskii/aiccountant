import uuid
from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.money import MoneyStr

ACCOUNT_TYPES = "^(card|cash|savings)$"
CATEGORY_KINDS = "^(income|expense)$"


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str = Field(pattern=ACCOUNT_TYPES)
    currency: str = Field(default="RUB", min_length=3, max_length=3)


class AccountUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    is_archived: bool | None = None


class AccountOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    currency: str
    is_archived: bool
    balance: MoneyStr


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(pattern=CATEGORY_KINDS)
    parent_id: uuid.UUID | None = None


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    parent_id: uuid.UUID | None = None


class CategoryOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    kind: str


class TransactionCreate(BaseModel):
    account_id: uuid.UUID
    category_id: uuid.UUID | None = None
    amount: Decimal
    occurred_at: date
    merchant: str | None = Field(default=None, max_length=300)
    note: str | None = Field(default=None, max_length=1000)


class TransactionUpdate(BaseModel):
    category_id: uuid.UUID | None = None
    amount: Decimal | None = None
    occurred_at: date | None = None
    merchant: str | None = Field(default=None, max_length=300)
    note: str | None = Field(default=None, max_length=1000)


class TransferCreate(BaseModel):
    from_account_id: uuid.UUID
    to_account_id: uuid.UUID
    from_amount: Decimal = Field(gt=0)
    to_amount: Decimal = Field(gt=0)
    occurred_at: date
    note: str | None = Field(default=None, max_length=1000)


class TransactionOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    category_id: uuid.UUID | None
    amount: MoneyStr
    currency: str
    occurred_at: date
    merchant: str | None
    note: str | None
    transfer_group_id: uuid.UUID | None


class TransactionList(BaseModel):
    items: list[TransactionOut]
    total: int


class DashboardAccount(BaseModel):
    id: uuid.UUID
    name: str
    currency: str
    balance: MoneyStr


class MonthExpense(BaseModel):
    category_id: uuid.UUID | None
    category_name: str
    total: MoneyStr


class RecentTransaction(BaseModel):
    id: uuid.UUID
    occurred_at: date
    amount: MoneyStr
    currency: str
    account_name: str
    category_name: str | None
    merchant: str | None
    is_transfer: bool


class DashboardOut(BaseModel):
    accounts: list[DashboardAccount]
    month_expenses: list[MonthExpense]
    recent: list[RecentTransaction]
