from collections.abc import Sequence
from typing import Protocol

import structlog

from app.imports.parser import ParsedStatement, StatementParseError

logger = structlog.get_logger()


class DeterministicParser(Protocol):
    """Парсер под конкретный формат банка: сам решает, его ли это выписка."""

    name: str

    def detect(self, lines: list[str]) -> bool: ...

    def parse(self, lines: list[str]) -> ParsedStatement: ...


class FallbackParser(Protocol):
    """Терминальный разборщик (LLM): применяется, когда формат не распознан.
    Асинхронный, потому что ходит к внешнему провайдеру."""

    name: str

    async def parse_async(self, lines: list[str]) -> ParsedStatement: ...


async def route_statement(
    lines: list[str],
    parsers: Sequence[DeterministicParser],
    fallback: FallbackParser,
) -> tuple[ParsedStatement, str]:
    """Отдать разбор первого узнавшего формат парсера; если никто не узнал или
    узнавший не справился — разобрать фолбэком. Возвращает (разбор, имя парсера)."""
    for parser in parsers:
        if not parser.detect(lines):
            continue
        try:
            return parser.parse(lines), parser.name
        except StatementParseError:
            # detect ошибся (похожая шапка) — не падаем, отдаём формат фолбэку
            logger.warning(
                "statement_parser_detect_mismatch", parser=parser.name, reason="parse_failed"
            )
    return await fallback.parse_async(lines), fallback.name
