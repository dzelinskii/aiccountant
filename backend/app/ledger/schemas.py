import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, Field, PlainSerializer

# деньги в БД — NUMERIC(20,4); наружу отдаём строкой с фиксированными
# 4 знаками (фронт не использует float, форма суммы стабильна)
_MONEY_SCALE = Decimal("0.0001")


def _money_str(value: Decimal) -> str:
    return str(value.quantize(_MONEY_SCALE))


MoneyStr = Annotated[Decimal, PlainSerializer(_money_str, return_type=str)]

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
    category_id: uuid.UUID
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
