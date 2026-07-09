from datetime import date
from decimal import Decimal

import pytest

from app.imports.parser import StatementParseError, extract_lines, parse_statement
from tests.fixtures import make_simple_pdf

# строки в формате реального извлечения pypdf из «Справки о движении средств»
SAMPLE = [
    "Движение средств за период с 06.06.2026 по 06.07.2026",
    "Дата и время",
    "операции",
    "Номер",
    "карты",
    "04.07.2026",
    "12:37",
    "04.07.2026",
    "12:37",
    "-1 150.00 ₽ -1 150.00 ₽ Внешний перевод по",
    "номеру телефона",
    "+79897050701",
    "9358",
    "02.07.2026",
    "17:12",
    "02.07.2026",
    "17:12",
    "+5 000.00 ₽ +5 000.00 ₽ Пополнение. Система",
    "быстрых платежей",
    "9358",
    "10.06.2026",
    "13:03",
    "10.06.2026",
    "13:03",
    "-14 405.33 ₽ -14 405.33 ₽ Пополнение Кубышки 9358",
    "451 358,48 ₽Пополнения:",
    "502 119,39 ₽Расходы:",
]


def test_parses_all_operations() -> None:
    st = parse_statement(SAMPLE)
    assert len(st.operations) == 3


def test_signed_amounts_and_dates() -> None:
    ops = parse_statement(SAMPLE).operations
    assert ops[0].occurred_at == date(2026, 7, 4)
    assert ops[0].amount == Decimal("-1150.00")
    assert ops[0].currency == "RUB"
    assert ops[1].amount == Decimal("5000.00")  # доход, знак +


def test_multiline_description_joined_card_stripped() -> None:
    ops = parse_statement(SAMPLE).operations
    assert ops[0].description == "Внешний перевод по номеру телефона +79897050701"
    # описание и номер карты на одной строке — карта отрезается
    assert ops[2].description == "Пополнение Кубышки"


def test_totals_control_sum() -> None:
    st = parse_statement(SAMPLE)
    assert st.total_income == Decimal("451358.48")
    assert st.total_expense == Decimal("502119.39")


def test_empty_or_garbage_raises() -> None:
    with pytest.raises(StatementParseError):
        parse_statement(["мусор", "нет операций"])


def test_extract_lines_reads_pdf_text() -> None:
    pdf = make_simple_pdf(["03.07.2026", "12:37", "Cafe payment"])
    lines = extract_lines(pdf)
    assert "03.07.2026" in lines
    assert "Cafe payment" in lines
