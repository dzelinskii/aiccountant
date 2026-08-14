import json
from datetime import date
from decimal import Decimal

import pytest

from app.imports.llm_parser import LLMStatementParser, StatementTooLargeError
from app.imports.parser import StatementParseError
from app.imports.routing import route_statement


class FakeLLM:
    """LLMClient с записанным ответом; сеть не дёргаем."""

    def __init__(self, answer: str) -> None:
        self._answer = answer
        self.prompts: list[str] = []

    async def complete_json(self, *, system: str, user: str) -> str:
        self.prompts.append(user)
        return self._answer


async def test_parses_valid_answer() -> None:
    answer = json.dumps(
        {
            "operations": [
                {"occurred_at": "2026-07-05", "amount": "-1150.00", "description": "Кофейня"},
                {"occurred_at": "2026-07-06", "amount": "5000.00", "description": "Зарплата"},
            ],
            "total_income": "5000.00",
            "total_expense": "1150.00",
        }
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    statement = await parser.parse_async(["любой", "текст"])

    assert len(statement.operations) == 2
    first = statement.operations[0]
    assert first.occurred_at == date(2026, 7, 5)
    assert first.amount == Decimal("-1150.00")  # суммы строками → Decimal, без float
    assert first.currency == "RUB"
    assert first.description == "Кофейня"
    assert statement.total_income == Decimal("5000.00")
    assert statement.total_expense == Decimal("1150.00")


async def test_broken_json_raises_parse_error() -> None:
    parser = LLMStatementParser(FakeLLM("это не json"), max_chars=10000)
    with pytest.raises(StatementParseError):
        await parser.parse_async(["текст"])


async def test_empty_operations_raise_parse_error() -> None:
    answer = json.dumps({"operations": [], "total_income": None, "total_expense": None})
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    with pytest.raises(StatementParseError):
        await parser.parse_async(["текст"])


async def test_invalid_operation_raises_parse_error() -> None:
    # непарсящаяся дата — жёсткая ошибка, в ручной разбор, а не молча пропустить
    answer = json.dumps(
        {"operations": [{"occurred_at": "вчера", "amount": "-10.00", "description": "x"}]}
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    with pytest.raises(StatementParseError):
        await parser.parse_async(["текст"])


async def test_zero_amount_raises_parse_error() -> None:
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "0.00", "description": "x"}]}
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    with pytest.raises(StatementParseError):
        await parser.parse_async(["текст"])


async def test_too_large_text_raises_before_llm_call() -> None:
    llm = FakeLLM("{}")
    parser = LLMStatementParser(llm, max_chars=10)
    with pytest.raises(StatementTooLargeError):
        await parser.parse_async(["очень длинный текст выписки, который не влезает в кап"])
    assert llm.prompts == []  # до провайдера не дошли — не жжём токены


async def test_prompt_contains_statement_text() -> None:
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}]}
    )
    llm = FakeLLM(answer)
    parser = LLMStatementParser(llm, max_chars=10000)
    await parser.parse_async(["СТРОКА-МАРКЕР"])
    assert "СТРОКА-МАРКЕР" in llm.prompts[0]


async def test_llm_parser_works_as_route_fallback() -> None:
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}]}
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    statement, name = await route_statement(["чужой формат"], [], parser)
    assert name == "llm"
    assert len(statement.operations) == 1
