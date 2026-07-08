from decimal import Decimal
from typing import Annotated

from pydantic import PlainSerializer

# деньги в БД — NUMERIC(20,4); наружу отдаём строкой с фиксированными
# 4 знаками (фронт не использует float, форма суммы стабильна)
_MONEY_SCALE = Decimal("0.0001")


def _money_str(value: Decimal) -> str:
    return str(value.quantize(_MONEY_SCALE))


MoneyStr = Annotated[Decimal, PlainSerializer(_money_str, return_type=str)]
