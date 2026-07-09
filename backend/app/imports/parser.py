import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
# строка сумм: сумма в валюте операции ₽, сумма в валюте карты ₽, затем начало описания
AMOUNT_LINE_RE = re.compile(
    r"^([+-][\d\s\xa0]+[.,]\d{2})\s*₽\s+([+-][\d\s\xa0]+[.,]\d{2})\s*₽\s*(.*)$"
)
CARD_RE = re.compile(r"^\d{3,4}$")
TOTAL_RE = re.compile(r"([\d\s\xa0]+[.,]\d{2})\s*₽")


class StatementParseError(Exception):
    """Не удалось разобрать выписку (неверный формат)."""


@dataclass
class ParsedOperation:
    occurred_at: date
    amount: Decimal  # знаковая: расход < 0, доход > 0
    currency: str
    description: str


@dataclass
class ParsedStatement:
    operations: list[ParsedOperation]
    total_income: Decimal | None
    total_expense: Decimal | None


def _money(raw: str) -> Decimal:
    return Decimal(raw.replace(" ", "").replace("\xa0", "").replace(",", "."))


def _parse_date(raw: str) -> date:
    d, m, y = raw.split(".")
    return date(int(y), int(m), int(d))


def _is_block_start(lines: list[str], j: int, n: int) -> bool:
    # операция начинается с блока: дата/время/дата/время/строка-сумма
    return (
        j + 4 < n
        and bool(DATE_RE.match(lines[j]))
        and bool(TIME_RE.match(lines[j + 1]))
        and bool(DATE_RE.match(lines[j + 2]))
        and bool(TIME_RE.match(lines[j + 3]))
        and bool(AMOUNT_LINE_RE.match(lines[j + 4]))
    )


def _clean_description(text: str) -> str:
    words = text.split()
    if words and re.fullmatch(r"\d{3,4}", words[-1]):
        words = words[:-1]  # хвостовой номер карты
    return " ".join(words).strip()


def parse_statement(raw_lines: list[str]) -> ParsedStatement:
    lines = [line.strip() for line in raw_lines if line.strip()]
    n = len(lines)
    operations: list[ParsedOperation] = []
    total_income: Decimal | None = None
    total_expense: Decimal | None = None

    i = 0
    while i < n:
        line = lines[i]
        if "Пополнения:" in line:
            match = TOTAL_RE.search(line)
            if match:
                total_income = _money(match.group(1))
            i += 1
            continue
        if "Расходы:" in line:
            match = TOTAL_RE.search(line)
            if match:
                total_expense = _money(match.group(1))
            i += 1
            continue
        if _is_block_start(lines, i, n):
            occurred_at = _parse_date(lines[i])
            amount_match = AMOUNT_LINE_RE.match(lines[i + 4])
            assert amount_match is not None
            amount = _money(amount_match.group(2))
            desc_parts = [amount_match.group(3)] if amount_match.group(3).strip() else []
            j = i + 5
            while (
                j < n
                and not _is_block_start(lines, j, n)
                and "Пополнения:" not in lines[j]
                and "Расходы:" not in lines[j]
            ):
                desc_parts.append(lines[j])
                j += 1
            operations.append(
                ParsedOperation(
                    occurred_at=occurred_at,
                    amount=amount,
                    currency="RUB",
                    description=_clean_description(" ".join(desc_parts)),
                )
            )
            i = j
            continue
        i += 1

    if not operations:
        raise StatementParseError("не найдено ни одной операции — неверный формат выписки")
    return ParsedStatement(operations, total_income, total_expense)
