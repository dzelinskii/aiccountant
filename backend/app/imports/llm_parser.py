import json
from datetime import date
from decimal import Decimal
from typing import Annotated

import structlog
from pydantic import BaseModel, Field, ValidationError

from app.ai.client import LLMClient
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError

logger = structlog.get_logger()

# границы совпадают с NUMERIC(20,4) в ledger: за ними Postgres молча округлит
# или упадёт уже на вставке — ловим это на разборе, а не после коммита
Money = Annotated[Decimal, Field(max_digits=20, decimal_places=4)]

SYSTEM_PROMPT = (
    "Ты разбираешь банковские выписки. По тексту выписки верни ТОЛЬКО JSON вида "
    '{"operations": [{"occurred_at": "ГГГГ-ММ-ДД", "amount": "-1150.00", '
    '"description": "описание"}], "total_income": "5000.00", "total_expense": "1150.00"}. '
    "Сумма — строка со знаком: расход отрицательный, приход положительный, точка как "
    "десятичный разделитель, не больше двух знаков после точки, без пробелов и символов "
    "валюты. Дата — строго ISO 8601 в формате ГГГГ-ММ-ДД; если в выписке дата дана как "
    "ДД.ММ.ГГГГ, сконвертируй. Если у операции указано несколько дат (например, дата "
    "совершения и дата обработки/списания), бери дату совершения операции. Итоги "
    "(total_income/total_expense) — положительные строки или null, если в выписке их нет. "
    "Не выдумывай операции: переноси только те, что есть в тексте."
)


class StatementTooLargeError(Exception):
    """Текст выписки больше допустимого — в LLM не отправляем."""


class _LLMOperation(BaseModel):
    occurred_at: date
    amount: Money
    description: str = ""


class _LLMStatement(BaseModel):
    operations: list[_LLMOperation]
    total_income: Money | None = None
    total_expense: Money | None = None


def _clean_description(text: str) -> str:
    # NUL: Postgres text-колонка его не примет, а Python не считает пробелом
    return " ".join(text.replace("\x00", "").split())


def _canonical_amount(amount: Decimal) -> Decimal:
    """Каноническая форма суммы: банки печатают копейки, а LLM может вернуть
    «1000» или «1000.00» для одной операции — разные строки дают разный dedup-хеш.
    Приводим к двум знакам, только если это не меняет значение (FX с четырьмя
    знаками оставляем как есть — молча округлять деньги нельзя)."""
    rounded = amount.quantize(Decimal("0.01"))
    return rounded if rounded == amount else amount


def _to_statement(payload: _LLMStatement) -> ParsedStatement:
    operations: list[ParsedOperation] = []
    for op in payload.operations:
        if op.amount == 0:
            # нулевая сумма ломает инвариант знака в ledger — это ошибка разбора
            raise StatementParseError("операция с нулевой суммой")
        operations.append(
            ParsedOperation(
                occurred_at=op.occurred_at,
                amount=_canonical_amount(op.amount),
                currency="RUB",
                description=_clean_description(op.description),
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
            # parse_float=Decimal: float для денег запрещён, даже как промежуточное
            # представление на пути json → pydantic
            data = json.loads(raw, parse_float=Decimal)
            payload = _LLMStatement.model_validate(data)
        except (json.JSONDecodeError, ValidationError) as exc:
            logger.warning("llm_statement_invalid_answer")
            raise StatementParseError("LLM вернул неразбираемый ответ") from exc
        return _to_statement(payload)
