from decimal import Decimal
from typing import Annotated

from pydantic import Field, PlainSerializer

# деньги в БД — NUMERIC(20,4); наружу отдаём строкой с фиксированными
# 4 знаками (фронт не использует float, форма суммы стабильна)
_MONEY_SCALE = Decimal("0.0001")


def _money_str(value: Decimal) -> str:
    return str(value.quantize(_MONEY_SCALE))


MoneyStr = Annotated[Decimal, PlainSerializer(_money_str, return_type=str)]

# границы совпадают с NUMERIC(20,4) в ledger — иначе переполнение всплывёт
# только на вставке строки, когда запрос уже признан правильным
Money = Annotated[Decimal, Field(max_digits=20, decimal_places=4)]


def reject_float(value: object) -> object:
    """Деньги приходят строкой, и float на входе — уже потерянные разряды.

    Проверка идёт до приведения типа: pydantic молча превратит 1234.5 в
    Decimal, и разница вылезет не здесь, а в сведении остатков.
    """
    if isinstance(value, float):
        raise ValueError("сумма должна быть строкой, а не числом JSON")
    return value
