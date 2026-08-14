import json
from datetime import date
from decimal import Decimal, InvalidOperation

import structlog
from pydantic import BaseModel, ValidationError

from app.ai.client import LLMClient
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError

logger = structlog.get_logger()

SYSTEM_PROMPT = (
    "Ты разбираешь банковские выписки. По тексту выписки верни ТОЛЬКО JSON вида "
    '{"operations": [{"occurred_at": "ГГГГ-ММ-ДД", "amount": "-1150.00", '
    '"description": "описание"}], "total_income": "5000.00", "total_expense": "1150.00"}. '
    "Сумма — строка со знаком: расход отрицательный, приход положительный, точка как "
    "десятичный разделитель, без пробелов и символов валюты. Итоги (total_income/"
    "total_expense) — положительные строки или null, если в выписке их нет. "
    "Не выдумывай операции: переноси только те, что есть в тексте."
)


class StatementTooLargeError(Exception):
    """Текст выписки больше допустимого — в LLM не отправляем."""


class _LLMOperation(BaseModel):
    occurred_at: date
    amount: Decimal
    description: str = ""


class _LLMStatement(BaseModel):
    operations: list[_LLMOperation]
    total_income: Decimal | None = None
    total_expense: Decimal | None = None


def _to_statement(payload: _LLMStatement) -> ParsedStatement:
    operations: list[ParsedOperation] = []
    for op in payload.operations:
        if op.amount == 0:
            # нулевая сумма ломает инвариант знака в ledger — это ошибка разбора
            raise StatementParseError("операция с нулевой суммой")
        operations.append(
            ParsedOperation(
                occurred_at=op.occurred_at,
                amount=op.amount,
                currency="RUB",
                description=" ".join(op.description.split()),
            )
        )
    if not operations:
        raise StatementParseError("LLM не нашёл ни одной операции")
    return ParsedStatement(
        operations=operations,
        total_income=payload.total_income,
        total_expense=payload.total_expense,
    )


class LLMStatementParser:
    """Фолбэк-разбор произвольной выписки: текст → строгий JSON → валидация кодом.
    Невалидный ответ — явная ошибка (в ручной разбор), а не молчаливый пропуск."""

    name = "llm"

    def __init__(self, llm: LLMClient, max_chars: int) -> None:
        self._llm = llm
        self._max_chars = max_chars

    async def parse_async(self, lines: list[str]) -> ParsedStatement:
        text = "\n".join(lines)
        if len(text) > self._max_chars:
            raise StatementTooLargeError("выписка слишком большая для LLM-разбора")
        raw = await self._llm.complete_json(system=SYSTEM_PROMPT, user=text)
        try:
            data = json.loads(raw)
            payload = _LLMStatement.model_validate(data)
        except (json.JSONDecodeError, TypeError, ValidationError, InvalidOperation) as exc:
            logger.warning("llm_statement_invalid_answer")
            raise StatementParseError("LLM вернул неразбираемый ответ") from exc
        return _to_statement(payload)
