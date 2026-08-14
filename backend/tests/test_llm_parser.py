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


async def test_text_exactly_at_cap_does_not_raise_too_large() -> None:
    # граница: ровно max_chars — это ещё «влезает», не «слишком много» (строгое >)
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}]}
    )
    max_chars = 10
    llm = FakeLLM(answer)
    parser = LLMStatementParser(llm, max_chars=max_chars)
    await parser.parse_async(["x" * max_chars])
    assert llm.prompts  # дошли до LLM — кап на границе не сработал


async def test_prompt_contains_statement_text() -> None:
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}]}
    )
    llm = FakeLLM(answer)
    parser = LLMStatementParser(llm, max_chars=10000)
    await parser.parse_async(["СТРОКА-МАРКЕР"])
    assert "СТРОКА-МАРКЕР" in llm.prompts[0]


async def test_description_normalizes_whitespace() -> None:
    answer = json.dumps(
        {
            "operations": [
                {
                    "occurred_at": "2026-07-05",
                    "amount": "-1.00",
                    "description": "  Кофейня\n\tна\x00   Тверской  ",
                }
            ]
        }
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    statement = await parser.parse_async(["текст"])
    assert statement.operations[0].description == "Кофейня на Тверской"
    assert "\x00" not in statement.operations[0].description


async def test_numeric_amount_keeps_full_precision() -> None:
    # сумма пришла JSON-числом, а не строкой: без parse_float=Decimal json.loads
    # материализует float и молча теряет разряд — деньги портятся до валидации
    raw = (
        '{"operations": [{"occurred_at": "2026-07-05", '
        '"amount": 12345678901234.5678, "description": "x"}]}'
    )
    parser = LLMStatementParser(FakeLLM(raw), max_chars=10000)
    statement = await parser.parse_async(["текст"])
    assert statement.operations[0].amount == Decimal("12345678901234.5678")


async def test_amount_without_cents_canonicalized_for_stable_dedup() -> None:
    # LLM может вернуть «1000» вместо «1000.00» для одной и той же операции —
    # разное строковое представление даёт разный dedup-хеш в _external_ids
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "1000", "description": "x"}]}
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    statement = await parser.parse_async(["текст"])
    assert statement.operations[0].amount == Decimal("1000.00")


async def test_amount_with_one_decimal_place_padded_to_two() -> None:
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "-1150.5", "description": "x"}]}
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    statement = await parser.parse_async(["текст"])
    assert statement.operations[0].amount == Decimal("-1150.50")


async def test_four_decimal_amount_not_silently_rounded() -> None:
    # четыре знака — вероятно валютный курс, а не копейки; округлять деньги молча нельзя
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "1150.1234", "description": "x"}]}
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    statement = await parser.parse_async(["текст"])
    assert statement.operations[0].amount == Decimal("1150.1234")


async def test_llm_parser_works_as_route_fallback() -> None:
    answer = json.dumps(
        {"operations": [{"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}]}
    )
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    statement, name = await route_statement(["чужой формат"], [], parser)
    assert name == "llm"
    assert len(statement.operations) == 1


def test_too_large_error_is_not_parse_error() -> None:
    # «слишком большая» — это предусловие вызова LLM (кап на вход текста), а не
    # ошибка разбора ответа; вызывающий код обязан ловить их по отдельности
    assert not issubclass(StatementTooLargeError, StatementParseError)


HOSTILE_PAYLOADS = [
    pytest.param(json.dumps({"operations": None}), id="operations-null"),
    pytest.param(
        json.dumps([{"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}]),
        id="top-level-list",
    ),
    pytest.param(
        json.dumps(
            {"operations": [{"occurred_at": "2026-07-05", "amount": {"a": 1}, "description": "x"}]}
        ),
        id="amount-nested-object",
    ),
    pytest.param(
        json.dumps(
            {"operations": [{"occurred_at": "2026-07-05", "amount": None, "description": "x"}]}
        ),
        id="amount-null",
    ),
    pytest.param(
        json.dumps(
            {"operations": [{"occurred_at": "2026-07-05", "amount": "NaN", "description": "x"}]}
        ),
        id="amount-nan",
    ),
    pytest.param(
        json.dumps(
            {
                "operations": [
                    {"occurred_at": "2026-07-05", "amount": "Infinity", "description": "x"}
                ]
            }
        ),
        id="amount-infinity",
    ),
    pytest.param(
        json.dumps(
            {
                "operations": [
                    {"occurred_at": "2026-07-05", "amount": "1E999999999", "description": "x"}
                ]
            }
        ),
        id="amount-huge-exponent",
    ),
    pytest.param(
        json.dumps(
            {
                "operations": [
                    {
                        "occurred_at": "2026-07-05",
                        "amount": "1150.123456789",
                        "description": "x",
                    }
                ]
            }
        ),
        id="amount-too-many-decimal-places",
    ),
    pytest.param(
        json.dumps(
            {"operations": [{"occurred_at": "05.07.2026", "amount": "-1.00", "description": "x"}]}
        ),
        id="date-not-iso8601",
    ),
    pytest.param(
        json.dumps(
            {
                "operations": [
                    {"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}
                ],
                "total_income": "1.00001",
            }
        ),
        id="total-income-too-many-decimal-places",
    ),
    pytest.param(
        json.dumps(
            {
                "operations": [
                    {"occurred_at": "2026-07-05", "amount": "-1.00", "description": "x"}
                ],
                "total_expense": "1E999999999",
            }
        ),
        id="total-expense-huge-exponent",
    ),
]


@pytest.mark.parametrize("answer", HOSTILE_PAYLOADS)
async def test_hostile_payload_raises_parse_error(answer: str) -> None:
    # фиксируем поведение на враждебных ответах LLM: ни один не должен долетать
    # до ledger как валидные данные, все — StatementParseError, без исключений
    parser = LLMStatementParser(FakeLLM(answer), max_chars=10000)
    with pytest.raises(StatementParseError):
        await parser.parse_async(["текст"])
