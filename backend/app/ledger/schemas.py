import uuid
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
