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


def test_tbank_parser_detects_own_format() -> None:
    parser = TBankStatementParser()
    assert parser.detect(["Справка о движении средств", "прочее"]) is True
    assert parser.detect(["Выписка по счёту Альфа-Банк"]) is False
