from datetime import date
from decimal import Decimal

import pytest

from app.imports.parser import (
    ParsedOperation,
    ParsedStatement,
    StatementParseError,
    TBankStatementParser,
)
from app.imports.routing import route_statement
from tests.test_statement_parser import SAMPLE


class _AlwaysParser:
    """Детерминированный парсер, который «узнаёт» свой формат по маркеру."""

    name = "always"

    def detect(self, lines: list[str]) -> bool:
        return any("МОЙБАНК" in line for line in lines)

    def parse(self, lines: list[str]) -> ParsedStatement:
        return ParsedStatement(
            operations=[
                ParsedOperation(
                    occurred_at=date(2026, 7, 5),
                    amount=Decimal("-10.00"),
                    currency="RUB",
                    description="тест",
                )
            ],
            total_income=None,
            total_expense=None,
        )


class _NeverParser:
    name = "never"

    def detect(self, lines: list[str]) -> bool:
        return False

    def parse(self, lines: list[str]) -> ParsedStatement:  # pragma: no cover
        raise AssertionError("не должен вызываться")


class _FallbackParser:
    """Фолбэк асинхронный — LLM ходит по сети."""

    name = "fallback"

    def __init__(self) -> None:
        self.called = False

    async def parse_async(self, lines: list[str]) -> ParsedStatement:
        self.called = True
        return ParsedStatement(operations=[], total_income=None, total_expense=None)


async def test_route_picks_first_detecting_parser() -> None:
    fallback = _FallbackParser()
    statement, name = await route_statement(
        ["шапка", "МОЙБАНК выписка"], [_NeverParser(), _AlwaysParser()], fallback
    )
    assert name == "always"
    assert len(statement.operations) == 1
    assert fallback.called is False


async def test_route_falls_back_when_nothing_detects() -> None:
    fallback = _FallbackParser()
    statement, name = await route_statement(["чужой формат"], [_NeverParser()], fallback)
    assert name == "fallback"
    assert fallback.called is True
    assert statement.operations == []


async def test_route_falls_back_when_detected_parser_fails() -> None:
    """detect может ошибиться (похожая шапка) — тогда пробуем фолбэк, а не падаем."""

    class _BrokenParser:
        name = "broken"

        def detect(self, lines: list[str]) -> bool:
            return True

        def parse(self, lines: list[str]) -> ParsedStatement:
            raise StatementParseError("не смог")

    fallback = _FallbackParser()
    _, name = await route_statement(["что-то"], [_BrokenParser()], fallback)
    assert name == "fallback"
    assert fallback.called is True


async def test_route_raises_when_fallback_also_fails() -> None:
    class _BrokenFallback:
        name = "llm"

        async def parse_async(self, lines: list[str]) -> ParsedStatement:
            raise StatementParseError("и фолбэк не смог")

    with pytest.raises(StatementParseError):
        await route_statement(["что-то"], [], _BrokenFallback())


async def test_route_picks_first_of_two_detecting_parsers() -> None:
    class _FirstParser:
        name = "first"

        def detect(self, lines: list[str]) -> bool:
            return True

        def parse(self, lines: list[str]) -> ParsedStatement:
            return ParsedStatement(operations=[], total_income=None, total_expense=None)

    class _SecondParser:
        name = "second"

        def detect(self, lines: list[str]) -> bool:
            return True

        def parse(self, lines: list[str]) -> ParsedStatement:  # pragma: no cover
            raise AssertionError("не должен вызываться — первый парсер уже выиграл")

    fallback = _FallbackParser()
    _, name = await route_statement(["что-то"], [_FirstParser(), _SecondParser()], fallback)
    assert name == "first"
    assert fallback.called is False


async def test_route_tries_next_parser_after_failure() -> None:
    class _BrokenParser:
        name = "broken"

        def detect(self, lines: list[str]) -> bool:
            return True

        def parse(self, lines: list[str]) -> ParsedStatement:
            raise StatementParseError("не смог")

    fallback = _FallbackParser()
    statement, name = await route_statement(
        ["МОЙБАНК выписка"], [_BrokenParser(), _AlwaysParser()], fallback
    )
    assert name == "always"
    assert len(statement.operations) == 1
    assert fallback.called is False


async def test_route_uses_real_tbank_parser_on_real_fixture() -> None:
    fallback = _FallbackParser()
    statement, name = await route_statement(SAMPLE, [TBankStatementParser()], fallback)
    assert name == "tbank_statement"
    assert len(statement.operations) == 3
    assert fallback.called is False


def test_tbank_parser_detects_own_format() -> None:
    parser = TBankStatementParser()
    assert parser.detect(["Движение средств за период с 06.06.2026 по 06.07.2026"]) is True
    assert parser.detect(["Выписка по счёту Альфа-Банк"]) is False


def test_tbank_parser_rejects_single_footer_marker() -> None:
    # одно «Расходы:» встречается и в выписках чужих банков — не должно матчить
    parser = TBankStatementParser()
    assert parser.detect(["АО Альфа-Банк", "Выписка", "Расходы: 100,00 RUB"]) is False


def test_tbank_parser_detects_both_footer_markers_without_header() -> None:
    parser = TBankStatementParser()
    assert parser.detect(["451 358,48 ₽Пополнения:", "502 119,39 ₽Расходы:"]) is True


def test_tbank_parser_wraps_bad_dates_as_statement_parse_error() -> None:
    # маркеры совпали, но строки внутри не разбираются (битая дата) — граница
    # парсера должна отдать StatementParseError, а не голый ValueError, чтобы
    # маршрутизатор ушёл в фолбэк, а не упал
    parser = TBankStatementParser()
    with pytest.raises(StatementParseError):
        parser.parse(["32.13.2026", "12:00", "32.13.2026", "12:00", "-1 150.00 ₽ -1 150.00 ₽ Тест"])
