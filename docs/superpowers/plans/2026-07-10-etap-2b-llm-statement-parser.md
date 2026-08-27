# LLM-парсер произвольных выписок (этап 2b, PDF, async) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Импортировать PDF-выписки любых банков: формат распознаётся реестром детерминированных парсеров, при неудаче — разбор через LLM; импорт становится асинхронным (Celery), парсим один раз, коммит — из сохранённого разбора.

**Architecture:** Абстракция `StatementParser` (detect+parse) + реестр; роутер «детерминированные по очереди → LLM-фолбэк» отдаёт единый `ParsedStatement`. LLM-парсер живёт в `imports`, зовёт `ai.LLMClient`. Поток: `POST /imports` (создать запись, извлечь текст, поставить задачу) → задача разбирает и сохраняет → `GET /imports/{id}` (статус/превью) → `POST /imports/{id}/commit` (создать операции из сохранённого).

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 async, Alembic, Celery/Redis, pypdf, `openai` (через модуль `ai`), structlog, pytest; фронт — React + Mantine + TanStack Query + vitest.

**Спека:** `docs/superpowers/specs/2026-07-10-etap-2b-llm-statement-parser-design.md`.

**Существующие соглашения (важно для исполнителя):**
- Команды из `backend/`: `uv run ruff format .`, `uv run ruff check .`, `uv run mypy`, `uv run lint-imports`, `uv run pytest`. Фронт — из `frontend/`: `pnpm test`, `pnpm lint`, `pnpm build`.
- Деньги/суммы — `Decimal`/`NUMERIC`, `float` запрещён везде; на проводе и в JSONB суммы — строками. Дата — `date`.
- Комментарии/коммиты — на русском, объясняют «почему»; без `Co-Authored-By`.
- В логи — только идентификаторы, без PII (описаний/сырого текста) и сумм.
- Каждый запрос/сервис фильтрует по `workspace_id`; утечка между workspace — критический баг.
- Тесты: pytest + pytest-asyncio (`asyncio_mode=auto`, async-тесты без декоратора); фикстура `db_session` поднимает Postgres (testcontainers) и применяет миграции до head. Фронт БЕЗ `@testing-library/jest-dom` — матчеры `.toBeDefined()`/`.toBeNull()`, тесты импортируют `{ expect, test, vi }` из 'vitest', оборачивают в `<MantineProvider>`.
- LLM в тестах — фейковая реализация `LLMClient` (метод `async complete_json(self, *, system, user) -> str`), возвращающая записанные ответы; сеть не дёргаем.

**Порядок задач и зелёные коммиты:** новый async-код строится РЯДОМ со старым синхронным потоком (Tasks 1–5), затем роутер и тесты переключаются на него и старый код удаляется (Task 6), затем фронт (Task 7). Каждый коммит оставляет весь набор тестов зелёным.

---

## Карта файлов

Создаются:
- `backend/app/imports/routing.py` — `DeterministicParser`/`FallbackParser` (Protocol) и `route_statement(...)`. Реестр парсеров собирается в `imports/tasks.py` (Task 5), предупреждения контрольной суммы считает `imports/service.py` (Task 4).
- `backend/app/imports/llm_parser.py` — `LLMStatementParser` + Pydantic-модель ответа LLM + валидация.
- `backend/app/imports/tasks.py` — Celery-задача `imports.parse_statement_job`.
- `backend/alembic/versions/0007_import_async.py` — миграция колонок.
- Тесты: `backend/tests/test_statement_routing.py`, `backend/tests/test_llm_parser.py`, `backend/tests/test_import_async_service.py`.

Модифицируются:
- `backend/app/core/settings.py` — `llm_model_parse`, `import_max_text_chars`.
- `backend/app/ai/client.py` — `build_llm_client(model=None)`.
- `backend/app/imports/parser.py` — `TBankStatementParser` (detect+parse) поверх существующей `parse_statement`.
- `backend/app/imports/models.py` — `parser`, `parsed_payload`, `error`.
- `backend/app/imports/schemas.py` — схемы async-потока.
- `backend/app/imports/service.py` — `start_import`, `run_parse`, `get_import_status`, `commit_from_import` (в Task 6 удаляются старые `preview`/`commit_import`).
- `backend/app/imports/repository.py` — `get_import`.
- `backend/app/imports/router.py` — новые эндпоинты (Task 6).
- `backend/app/core/celery_app.py` — autodiscover `app.imports` + импорт `app.imports.models`.
- `backend/pyproject.toml` — `ignore_imports` для `imports.tasks -> core.celery_app`.
- `backend/tests/test_celery_bootstrap.py` — проверка регистрации задачи.
- `backend/tests/test_imports_api.py`, `backend/tests/test_import_dedup_service.py` — на async-поток (Task 6).
- `frontend/src/api/imports.ts`, `frontend/src/pages/ImportPage.tsx`, `frontend/src/pages/ImportPreviewPanel.tsx` (+ тест) — async с поллингом (Task 7).

---

## Task 1: Абстракция парсера и реестр с маршрутизацией

**Files:**
- Create: `backend/app/imports/routing.py`
- Modify: `backend/app/imports/parser.py` (добавить `TBankStatementParser`, не трогая существующие функции)
- Test: `backend/tests/test_statement_routing.py`

Существующий `parser.py` содержит `extract_lines(pdf_bytes) -> list[str]`, `parse_statement(lines) -> ParsedStatement`, `StatementParseError`, dataclass'ы `ParsedOperation(occurred_at, amount, currency, description)` и `ParsedStatement(operations, total_income, total_expense)`. Их не меняем — оборачиваем.

- [ ] **Step 1: Написать падающий тест маршрутизации**

Создать `backend/tests/test_statement_routing.py`:

```python
from datetime import date
from decimal import Decimal

import pytest

from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError
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
```

- [ ] **Step 2: Прогнать — должен падать**

Run: `uv run pytest tests/test_statement_routing.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.imports.routing'`.

- [ ] **Step 3: Реализовать реестр и маршрутизацию**

Создать `backend/app/imports/routing.py`:

```python
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
    parsers: list[DeterministicParser],
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
            logger.warning("statement_parser_detect_mismatch", parser=parser.name)
    return await fallback.parse_async(lines), fallback.name
```

- [ ] **Step 4: Обернуть парсер Т-Банка в интерфейс**

В `backend/app/imports/parser.py` добавить в КОНЕЦ файла:

```python
TBANK_MARKERS = ("Справка о движении средств", "Пополнения:", "Расходы:")


class TBankStatementParser:
    """Детерминированный парсер «Справки о движении средств» Т-Банка."""

    name = "tbank_statement"

    def detect(self, lines: list[str]) -> bool:
        # узнаём формат по устойчивым маркерам шапки/футера справки
        text = "\n".join(lines)
        return any(marker in text for marker in TBANK_MARKERS)

    def parse(self, lines: list[str]) -> ParsedStatement:
        return parse_statement(lines)
```

- [ ] **Step 5: Добавить тест распознавания Т-Банка**

В конец `backend/tests/test_statement_routing.py` добавить:

```python
from app.imports.parser import TBankStatementParser


def test_tbank_parser_detects_own_format() -> None:
    parser = TBankStatementParser()
    assert parser.detect(["Справка о движении средств", "прочее"]) is True
    assert parser.detect(["Выписка по счёту Альфа-Банк"]) is False
```

- [ ] **Step 6: Прогнать — должны проходить**

Run: `uv run pytest tests/test_statement_routing.py tests/test_statement_parser.py -q`
Expected: PASS (новые тесты + существующие тесты парсера не сломались).

- [ ] **Step 7: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 8: Commit**

```bash
git add app/imports/routing.py app/imports/parser.py tests/test_statement_routing.py
git commit -m "Импорт: абстракция парсера выписки, реестр форматов и маршрутизация с фолбэком"
```

---

## Task 2: LLM-парсер выписки (записанные ответы, валидация кодом)

**Files:**
- Modify: `backend/app/core/settings.py`
- Modify: `backend/app/ai/client.py`
- Create: `backend/app/imports/llm_parser.py`
- Test: `backend/tests/test_llm_parser.py`

- [ ] **Step 1: Добавить настройки разбора**

В `backend/app/core/settings.py` в класс `Settings` после `llm_model_categorize` добавить:

```python
    # разбор произвольной выписки тяжелее категоризации — отдельная модель
    llm_model_parse: str = "gpt-4o-mini"
    # кап на объём текста выписки, уходящий в LLM (символы); больше — отказ с понятной ошибкой
    import_max_text_chars: int = 60000
```

- [ ] **Step 2: Разрешить выбор модели в фабрике**

В `backend/app/ai/client.py` заменить функцию `build_llm_client` на:

```python
def build_llm_client(model: str | None = None) -> OpenAICompatLLMClient:
    settings = get_settings()
    # пустой ключ намеренно допускаем: локальные keyless-эндпоинты (Ollama) его не
    # требуют, а ошибка авторизации (если ключ нужен) всплывёт при первом вызове
    client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key or "unset")
    return OpenAICompatLLMClient(client, model or settings.llm_model_categorize)
```

- [ ] **Step 3: Написать падающие тесты LLM-парсера**

Создать `backend/tests/test_llm_parser.py`:

```python
import json
from datetime import date
from decimal import Decimal

import pytest

from app.imports.llm_parser import LLMStatementParser, StatementTooLargeError
from app.imports.parser import StatementParseError


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
```

- [ ] **Step 4: Прогнать — должны падать**

Run: `uv run pytest tests/test_llm_parser.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.imports.llm_parser'`.

- [ ] **Step 5: Реализовать LLM-парсер**

Создать `backend/app/imports/llm_parser.py`:

```python
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
```

- [ ] **Step 6: Прогнать — должны проходить**

Run: `uv run pytest tests/test_llm_parser.py tests/test_ai_client.py -q`
Expected: PASS (в т.ч. существующие тесты `build_llm_client` — сигнатура расширена с дефолтом, обратно совместима).

- [ ] **Step 7: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 8: Commit**

```bash
git add app/core/settings.py app/ai/client.py app/imports/llm_parser.py tests/test_llm_parser.py
git commit -m "Импорт: LLM-разбор произвольной выписки со строгой валидацией ответа"
```

---

## Task 3: Данные async-импорта (модель + миграция 0007)

**Files:**
- Modify: `backend/app/imports/models.py`
- Create: `backend/alembic/versions/0007_import_async.py`
- Modify: `backend/tests/test_migrations.py`

Последняя миграция — `0006_categorization.py` (revision "0006"). Существующая таблица `imports` уже имеет `bank_profile`, `status`, `stats`.

- [ ] **Step 1: Написать падающий тест миграции**

В `backend/tests/test_migrations.py` есть тест-образец, проверяющий колонки через `information_schema` (например `test_migrations_add_categorization_columns`). Прочитать его и добавить по тому же образцу (те же фикстуры/утилиты файла) тест:

```python
async def test_migrations_add_import_async_columns(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'imports'"
            )
        )
        columns = {name for (name,) in rows.all()}
    await engine.dispose()
    assert {"parser", "parsed_payload", "error", "raw_text"} <= columns
```

(Импорты `create_async_engine`/`text` в файле уже есть — если нет, добавить в верхний блок импортов.)

- [ ] **Step 2: Прогнать — должен падать**

Run: `uv run pytest tests/test_migrations.py -q`
Expected: FAIL — в `imports` нет колонок `parser`/`parsed_payload`/`error`/`raw_text`.

- [ ] **Step 3: Расширить модель**

В `backend/app/imports/models.py` в класс `Import` после `stats` добавить:

```python
    # какой парсер разобрал выписку (профиль банка или "llm"); пусто, пока идёт разбор
    parser: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # результат разбора: операции и итоги строками (деньги в JSON — строки, не float)
    parsed_payload: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    # текст ошибки для статуса failed — показываем пользователю, не глотаем
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # текст выписки нужен фоновой задаче; PII — очищаем сразу после разбора
    raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
```

и добавить `Text` в импорт из sqlalchemy:
`from sqlalchemy import DateTime, ForeignKey, String, Text, func`.

`stats` менять не нужно: `start_import` (Task 4) создаёт запись со `stats={}`.

- [ ] **Step 4: Написать миграцию 0007**

Создать `backend/alembic/versions/0007_import_async.py`:

```python
"""Асинхронный импорт: parser/parsed_payload/error в imports"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("imports", sa.Column("parser", sa.String(30), nullable=True))
    op.add_column(
        "imports",
        sa.Column("parsed_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column("imports", sa.Column("error", sa.String(500), nullable=True))
    op.add_column("imports", sa.Column("raw_text", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("imports", "raw_text")
    op.drop_column("imports", "error")
    op.drop_column("imports", "parsed_payload")
    op.drop_column("imports", "parser")
```

- [ ] **Step 5: Прогнать — должен проходить**

Run: `uv run pytest tests/test_migrations.py -q`
Expected: PASS (цепочка 0001→0007 применяется, колонки на месте).

- [ ] **Step 6: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 7: Commit**

```bash
git add app/imports/models.py alembic/versions/0007_import_async.py tests/test_migrations.py
git commit -m "Импорт: поля async-разбора (parser/parsed_payload/error) + миграция 0007"
```

---

## Task 4: Сервис async-импорта (старт, разбор, статус, коммит)

**Files:**
- Modify: `backend/app/imports/schemas.py`
- Modify: `backend/app/imports/repository.py`
- Modify: `backend/app/imports/service.py` (ДОБАВИТЬ новые функции; старые `preview`/`commit_import` пока не трогать — их удалит Task 6)
- Test: `backend/tests/test_import_async_service.py`

Существующие приватные хелперы `_external_ids(account_id, operations)` и `_check_control_sum(statement)` переиспользуются.

- [ ] **Step 1: Добавить схемы async-потока**

В `backend/app/imports/schemas.py` добавить в конец:

```python
class ImportStartedOut(BaseModel):
    import_id: uuid.UUID
    status: str


class ImportStatusOut(BaseModel):
    import_id: uuid.UUID
    status: str  # processing | ready | failed
    parser: str | None
    error: str | None
    warnings: list[str]
    preview: ImportPreviewOut | None
```

- [ ] **Step 2: Добавить выборки записи импорта**

В `backend/app/imports/repository.py` добавить (импорты `Import`/`AsyncSession` в файле уже есть):

```python
import uuid

from sqlalchemy import select


async def get_import(
    db: AsyncSession, workspace_id: uuid.UUID, import_id: uuid.UUID
) -> Import | None:
    result: Import | None = await db.scalar(
        select(Import).where(Import.id == import_id, Import.workspace_id == workspace_id)
    )
    return result


async def get_import_any_workspace(db: AsyncSession, import_id: uuid.UUID) -> Import | None:
    """Для фоновой задачи: workspace берём из самой записи, а не из запроса."""
    result: Import | None = await db.scalar(select(Import).where(Import.id == import_id))
    return result
```

- [ ] **Step 3: Написать падающие тесты сервиса**

Создать `backend/tests/test_import_async_service.py`:

```python
import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import repository, service
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError

ALICE = {"email": "alice@example.com", "password": "password123"}

SAMPLE = ParsedStatement(
    operations=[
        ParsedOperation(
            occurred_at=date(2026, 7, 5),
            amount=Decimal("-1150.00"),
            currency="RUB",
            description="Кофейня",
        ),
        ParsedOperation(
            occurred_at=date(2026, 7, 6),
            amount=Decimal("5000.00"),
            currency="RUB",
            description="Зарплата",
        ),
    ],
    total_income=Decimal("5000.00"),
    total_expense=Decimal("1150.00"),
)


async def _bootstrap(client: AsyncClient) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    reg = await client.post("/api/auth/register", json=ALICE)
    user_id = uuid.UUID(reg.json()["id"])
    me = await client.get("/api/me")
    ws = uuid.UUID(me.json()["workspaces"][0]["id"])
    acc = uuid.UUID(
        (
            await client.post(
                "/api/accounts",
                params={"workspace_id": str(ws)},
                json={"name": "Карта", "type": "card", "currency": "RUB"},
            )
        ).json()["id"]
    )
    return user_id, ws, acc


async def test_start_import_creates_processing_record(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(
        db_session, ws, acc, user_id, "statement.pdf", ["строка выписки"]
    )
    assert imp.status == "processing"
    assert imp.parsed_payload is None
    stored = await repository.get_import(db_session, ws, imp.id)
    assert stored is not None
    # сырой текст сохранён для фоновой задачи
    assert stored.parsed_payload is None


def _fixed_parse(
    statement: ParsedStatement, name: str
) -> Callable[[list[str]], Awaitable[tuple[ParsedStatement, str]]]:
    """Колбэк разбора с заранее известным результатом (разбор асинхронный — LLM)."""

    async def _parse(lines: list[str]) -> tuple[ParsedStatement, str]:
        return statement, name

    return _parse


async def test_run_parse_stores_ready_payload(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "tbank_statement"))

    await db_session.refresh(imp)
    assert imp.status == "ready"
    assert imp.parser == "tbank_statement"
    assert imp.error is None
    payload = imp.parsed_payload
    assert payload is not None
    # суммы в JSONB — строками, не float
    assert payload["operations"][0]["amount"] == "-1150.00"
    assert payload["total_income"] == "5000.00"


async def test_run_parse_marks_failed_on_error(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    async def _boom(lines: list[str]) -> tuple[ParsedStatement, str]:
        raise StatementParseError("формат не распознан")

    await service.run_parse(db_session, imp.id, parse=_boom)

    await db_session.refresh(imp)
    assert imp.status == "failed"
    assert imp.error is not None
    assert imp.parsed_payload is None


async def test_status_returns_preview_with_duplicate_flags(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    status = await service.get_import_status(db_session, ws, imp.id)
    assert status is not None
    assert status.status == "ready"
    assert status.parser == "llm"
    assert status.preview is not None
    assert status.preview.new_count == 2
    assert status.preview.duplicate_count == 0
    assert all(op.is_duplicate is False for op in status.preview.operations)


async def test_commit_creates_transactions_and_is_idempotent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    result = await service.commit_from_import(db_session, ws, imp.id, user_id)
    assert result.imported == 2
    assert result.duplicates == 0

    # повторный коммит того же импорта не задваивает операции
    again = await service.commit_from_import(db_session, ws, imp.id, user_id)
    assert again.imported == 0
    assert again.duplicates == 2


async def test_control_sum_mismatch_becomes_warning(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    skewed = ParsedStatement(
        operations=SAMPLE.operations,
        total_income=Decimal("999.00"),  # не сходится с суммой операций
        total_expense=Decimal("1150.00"),
    )
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(skewed, "llm"))

    status = await service.get_import_status(db_session, ws, imp.id)
    assert status is not None
    # расхождение итогов — мягкая ошибка: разбор готов, но с предупреждением
    assert status.status == "ready"
    assert status.warnings


async def test_import_of_other_workspace_not_visible(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    assert await service.get_import_status(db_session, uuid.uuid4(), imp.id) is None
```

- [ ] **Step 4: Прогнать — должны падать**

Run: `uv run pytest tests/test_import_async_service.py -q`
Expected: FAIL — `AttributeError: module 'app.imports.service' has no attribute 'start_import'`.

- [ ] **Step 5: Реализовать сервис async-импорта**

В `backend/app/imports/service.py` добавить импорты вверху (к существующим):

```python
from collections.abc import Awaitable, Callable
from datetime import date

from app.imports.parser import StatementParseError
from app.imports.schemas import ImportStatusOut
```

и добавить в конец файла:

```python
RAW_TEXT_KEY = "raw_lines"


def _statement_to_payload(statement: ParsedStatement, warnings: list[str]) -> dict[str, object]:
    # деньги в JSON — строками: Decimal не сериализуется, а float для денег запрещён
    return {
        "operations": [
            {
                "occurred_at": op.occurred_at.isoformat(),
                "amount": str(op.amount),
                "currency": op.currency,
                "description": op.description,
            }
            for op in statement.operations
        ],
        "total_income": None if statement.total_income is None else str(statement.total_income),
        "total_expense": None if statement.total_expense is None else str(statement.total_expense),
        "warnings": warnings,
    }


def _payload_to_statement(payload: dict[str, object]) -> ParsedStatement:
    raw_ops = payload.get("operations") or []
    operations = [
        ParsedOperation(
            occurred_at=date.fromisoformat(str(op["occurred_at"])),
            amount=Decimal(str(op["amount"])),
            currency=str(op["currency"]),
            description=str(op["description"]),
        )
        for op in raw_ops  # type: ignore[union-attr]
    ]
    income = payload.get("total_income")
    expense = payload.get("total_expense")
    return ParsedStatement(
        operations=operations,
        total_income=None if income is None else Decimal(str(income)),
        total_expense=None if expense is None else Decimal(str(expense)),
    )


def _control_sum_warnings(statement: ParsedStatement) -> list[str]:
    """Расхождение итогов — мягкая ошибка: показываем предупреждение, но даём импортировать."""
    warnings: list[str] = []
    income = sum((op.amount for op in statement.operations if op.amount > 0), Decimal(0))
    expense = sum((-op.amount for op in statement.operations if op.amount < 0), Decimal(0))
    if statement.total_income is not None and income != statement.total_income:
        warnings.append("Сумма поступлений не сошлась с итогом выписки")
    if statement.total_expense is not None and expense != statement.total_expense:
        warnings.append("Сумма расходов не сошлась с итогом выписки")
    return warnings


async def start_import(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user_id: uuid.UUID,
    file_name: str,
    lines: list[str],
) -> Import:
    """Создать запись импорта со статусом processing и сохранённым текстом выписки."""
    imp = Import(
        workspace_id=workspace_id,
        account_id=account_id,
        file_name=file_name,
        bank_profile="",  # заполнится именем сработавшего парсера после разбора
        status="processing",
        stats={},
        created_by=user_id,
    )
    imp.raw_text = "\n".join(lines)
    repository.add_import(db, imp)
    await db.commit()
    return imp


async def run_parse(
    db: AsyncSession,
    import_id: uuid.UUID,
    *,
    parse: Callable[[list[str]], Awaitable[tuple[ParsedStatement, str]]],
) -> None:
    """Разобрать сохранённый текст и записать результат. Разбор асинхронный (LLM-фолбэк
    ходит по сети). Ошибка разбора — статус failed с понятным текстом, не молчаливый пропуск."""
    imp = await repository.get_import_any_workspace(db, import_id)
    if imp is None:
        return
    lines = (imp.raw_text or "").splitlines()
    try:
        statement, parser_name = await parse(lines)
    except Exception as exc:  # разбор мог упасть и в LLM, и в детерминированном парсере
        imp.status = "failed"
        imp.error = str(exc)[:500]
        imp.raw_text = None  # PII: сырой текст больше не нужен
        await db.commit()
        logger.warning("import_parse_failed", import_id=str(imp.id))
        return
    warnings = _control_sum_warnings(statement)
    imp.parser = parser_name
    imp.bank_profile = parser_name
    imp.parsed_payload = _statement_to_payload(statement, warnings)
    imp.status = "ready"
    imp.error = None
    imp.raw_text = None  # PII: дальше работаем с разобранными операциями
    await db.commit()
    logger.info("import_parsed", import_id=str(imp.id), parser=parser_name)


async def get_import_status(
    db: AsyncSession, workspace_id: uuid.UUID, import_id: uuid.UUID
) -> ImportStatusOut | None:
    imp = await repository.get_import(db, workspace_id, import_id)
    if imp is None:
        return None
    preview = None
    warnings: list[str] = []
    if imp.status == "ready" and imp.parsed_payload is not None:
        payload = imp.parsed_payload
        warnings = [str(w) for w in (payload.get("warnings") or [])]  # type: ignore[union-attr]
        statement = _payload_to_statement(payload)
        preview = await _build_preview(db, workspace_id, imp.account_id, statement)
    return ImportStatusOut(
        import_id=imp.id,
        status=imp.status,
        parser=imp.parser,
        error=imp.error,
        warnings=warnings,
        preview=preview,
    )


async def _build_preview(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    statement: ParsedStatement,
) -> ImportPreviewOut:
    ext_ids = _external_ids(account_id, statement.operations)
    existing = await ledger_service.existing_external_ids(
        db, workspace_id, account_id, set(ext_ids)
    )
    seen: set[str] = set()
    operations: list[ImportOperationOut] = []
    new_count = 0
    for op, eid in zip(statement.operations, ext_ids, strict=True):
        is_duplicate = eid in existing or eid in seen
        seen.add(eid)
        if not is_duplicate:
            new_count += 1
        operations.append(
            ImportOperationOut(
                occurred_at=op.occurred_at,
                amount=op.amount,
                currency=op.currency,
                description=op.description,
                is_duplicate=is_duplicate,
            )
        )
    return ImportPreviewOut(
        operations=operations,
        new_count=new_count,
        duplicate_count=len(operations) - new_count,
        total_income=statement.total_income,
        total_expense=statement.total_expense,
    )


async def commit_from_import(
    db: AsyncSession, workspace_id: uuid.UUID, import_id: uuid.UUID, user_id: uuid.UUID
) -> ImportResultOut:
    """Создать операции из уже разобранного импорта — повторно не парсим."""
    imp = await repository.get_import(db, workspace_id, import_id)
    if imp is None or imp.status != "ready" or imp.parsed_payload is None:
        raise StatementParseError("импорт не готов к подтверждению")
    statement = _payload_to_statement(imp.parsed_payload)
    ext_ids = _external_ids(imp.account_id, statement.operations)
    existing = await ledger_service.existing_external_ids(
        db, workspace_id, imp.account_id, set(ext_ids)
    )

    seen: set[str] = set()
    imported = 0
    for op, eid in zip(statement.operations, ext_ids, strict=True):
        if eid in existing or eid in seen:
            continue
        seen.add(eid)
        await ledger_service.post_transaction(
            db,
            workspace_id,
            user_id,
            account_id=imp.account_id,
            category_id=None,
            amount=op.amount,
            occurred_at=op.occurred_at,
            source="import",
            merchant=op.description[:300] or None,
            external_id=eid,
            import_id=imp.id,
        )
        imported += 1

    duplicates = len(statement.operations) - imported
    imp.stats = {
        "parsed": len(statement.operations),
        "imported": imported,
        "duplicates": duplicates,
    }
    await db.commit()
    if imported:
        ledger_service.enqueue_categorization(workspace_id)
    return ImportResultOut(import_id=imp.id, imported=imported, duplicates=duplicates)
```

- [ ] **Step 6: Прогнать — должны проходить**

Run: `uv run pytest tests/test_import_async_service.py -q`
Expected: PASS (все семь тестов).

- [ ] **Step 7: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 8: Commit**

```bash
git add app/imports/service.py app/imports/schemas.py app/imports/repository.py tests/test_import_async_service.py
git commit -m "Импорт: сервис асинхронного разбора (старт, разбор, статус, коммит из сохранённого)"
```

---

## Task 5: Celery-задача разбора и сборка парсеров

**Files:**
- Create: `backend/app/imports/tasks.py`
- Modify: `backend/app/core/celery_app.py`
- Modify: `backend/pyproject.toml` (ignore_imports)
- Modify: `backend/tests/test_celery_bootstrap.py`

- [ ] **Step 1: Реализовать задачу и сборку парсеров**

Создать `backend/app/imports/tasks.py`:

```python
import asyncio
import uuid

from app.ai.client import build_llm_client
from app.core.celery_app import celery_app
from app.core.db import session_factory
from app.core.settings import get_settings
from app.imports import service
from app.imports.llm_parser import LLMStatementParser
from app.imports.parser import ParsedStatement, TBankStatementParser
from app.imports.routing import route_statement

# детерминированные парсеры банков в порядке проверки; новый банк = ещё один элемент
DETERMINISTIC_PARSERS = (TBankStatementParser(),)


async def parse_lines(lines: list[str]) -> tuple[ParsedStatement, str]:
    """Реестр форматов: сначала детерминированные парсеры, затем LLM-фолбэк."""
    settings = get_settings()
    llm = LLMStatementParser(
        build_llm_client(settings.llm_model_parse), settings.import_max_text_chars
    )
    return await route_statement(lines, list(DETERMINISTIC_PARSERS), llm)


# decorator без типов из celery (ignore_missing_imports) → помечаем явно
@celery_app.task(name="imports.parse_statement_job")  # type: ignore[untyped-decorator]
def parse_statement_job(import_id: str) -> None:
    """Тонкая обёртка: доменная логика — в service.run_parse."""
    asyncio.run(_run(uuid.UUID(import_id)))


async def _run(import_id: uuid.UUID) -> None:
    async with session_factory() as db:
        await service.run_parse(db, import_id, parse=parse_lines)


def enqueue_parse(import_id: uuid.UUID) -> None:
    """Поставить разбор выписки в очередь Celery."""
    parse_statement_job.delay(str(import_id))
```

- [ ] **Step 2: Reaper застрявших импортов (beat)**

Если воркер умер или брокер потерял сообщение, запись остаётся в `processing`
навсегда — с непустым `raw_text` (PII) и вечным поллингом на фронте. Гарантия
«сырой текст живёт только до конца разбора» без этого не выполняется.

В `backend/app/imports/repository.py` добавить:

```python
async def stuck_processing(db: AsyncSession, older_than: datetime) -> list[Import]:
    """Импорты, застрявшие в разборе (воркер умер / сообщение потеряно)."""
    rows = await db.execute(
        select(Import).where(Import.status == "processing", Import.created_at < older_than)
    )
    return list(rows.scalars().all())
```

(добавить `from datetime import datetime` в импорты.)

В `backend/app/imports/service.py`:

```python
async def fail_stuck_imports(db: AsyncSession, older_than: datetime) -> int:
    """Пометить зависшие разборы как failed и стереть сырой текст (PII)."""
    stuck = await repository.stuck_processing(db, older_than)
    for imp in stuck:
        imp.status = "failed"
        imp.error = "Разбор не завершился — попробуйте загрузить файл ещё раз"
        imp.raw_text = None
        logger.warning("import_parse_stuck", import_id=str(imp.id))
    if stuck:
        await db.commit()
    return len(stuck)
```

В `backend/app/imports/tasks.py` добавить задачу и в `celery_app.conf.beat_schedule`
(в `backend/app/core/celery_app.py`) — запись `"reap-stuck-imports"` с
`{"task": "imports.reap_stuck", "schedule": 600.0}`:

```python
@celery_app.task(name="imports.reap_stuck")  # type: ignore[untyped-decorator]
def reap_stuck_imports() -> int:
    return asyncio.run(_reap())


async def _reap() -> int:
    # запас больше самого долгого разумного LLM-разбора
    threshold = datetime.now(UTC) - timedelta(minutes=15)
    async with session_factory() as db:
        return await service.fail_stuck_imports(db, threshold)
```

(импорты `from datetime import UTC, datetime, timedelta`.)

Тест в `backend/tests/test_import_async_service.py`:

```python
async def test_fail_stuck_imports_clears_raw_text(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    # порог в будущем — запись считается зависшей
    failed = await service.fail_stuck_imports(db_session, datetime.now(UTC) + timedelta(hours=1))

    assert failed == 1
    await db_session.refresh(imp)
    assert imp.status == "failed"
    assert imp.raw_text is None  # PII не остаётся висеть
```

- [ ] **Step 3: Зарегистрировать задачу в Celery**

В `backend/app/core/celery_app.py`:
- заменить `celery_app.autodiscover_tasks(["app.recurring", "app.ledger"])` на
  `celery_app.autodiscover_tasks(["app.recurring", "app.ledger", "app.imports"])`;
- в блок импортов моделей внизу добавить:
  `from app.imports import models as _imports_models  # noqa: E402,F401`.

- [ ] **Step 4: Ослабить контракт import-linter на ребро tasks→celery_app**

В `backend/pyproject.toml` в контракте `imports не лезет во внутренности identity и ledger`:
- добавить `"app.imports.tasks"` в `source_modules`;
- в `ignore_imports` добавить `"app.imports.tasks -> app.core.celery_app"` с комментарием-обоснованием (bootstrap воркера регистрирует ORM-модели всех модулей — инфраструктура, не обход границы; ровно как у `recurring.tasks`/`ledger.tasks`).

- [ ] **Step 5: Расширить bootstrap-тест воркера**

В `backend/tests/test_celery_bootstrap.py` в строку-код субпроцесса добавить (рядом с существующей проверкой `ledger.categorize_workspace`):

```python
        "assert 'imports.parse_statement_job' in celery_app.tasks\n"
```

и в набор `need` добавить `'imports'`.

- [ ] **Step 6: Прогнать**

Run: `uv run pytest tests/test_celery_bootstrap.py tests/test_statement_routing.py tests/test_import_async_service.py -q`
Expected: PASS.

- [ ] **Step 7: Линт/типы/границы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports`
Expected: без ошибок; `Contracts: 7 kept, 0 broken`.

- [ ] **Step 8: Commit**

```bash
git add app/imports/tasks.py app/imports/service.py app/imports/repository.py app/core/celery_app.py pyproject.toml tests/test_celery_bootstrap.py tests/test_import_async_service.py
git commit -m "Импорт: Celery-задача разбора выписки, реестр парсеров и reaper зависших импортов"
```

---

## Task 6: Переключить API на async-поток и удалить синхронный

**Files:**
- Modify: `backend/app/imports/router.py`
- Modify: `backend/app/imports/service.py` (удалить старые `preview`/`commit_import`/`_parse`/`_check_control_sum`)
- Modify: `backend/tests/test_imports_api.py`
- Modify: `backend/tests/test_import_dedup_service.py` (если ссылается на удалённые функции)

Старый эндпоинт `POST /api/imports?...&commit=false|true` заменяется тремя: старт, статус, коммит.

- [ ] **Step 1: Переписать тесты API под async-поток**

Прочитать `backend/tests/test_imports_api.py` — там есть образец: monkeypatch `app.imports.service.extract_lines` (или `app.imports.parser.extract_lines`) на фиксированные строки выписки и POST multipart с PDF-байтами. Переписать файл под новый поток, сохранив стиль. Тесты:

```python
async def test_start_returns_202_and_processing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws, acc = await _ws_and_account(client)
    monkeypatch.setattr("app.imports.router.extract_lines", lambda data: SAMPLE_LINES)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("s.pdf", b"%PDF-fake", "application/pdf")},
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "processing"
    assert body["import_id"]


async def test_status_and_commit_flow(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws, acc = await _ws_and_account(client)
    monkeypatch.setattr("app.imports.router.extract_lines", lambda data: SAMPLE_LINES)
    started = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("s.pdf", b"%PDF-fake", "application/pdf")},
    )
    import_id = started.json()["import_id"]

    # задача в тестах не выполняется (брокер заглушен) — разбираем вручную
    async def _parse(lines: list[str]) -> tuple[ParsedStatement, str]:
        return SAMPLE_STATEMENT, "tbank_statement"

    await service.run_parse(db_session, uuid.UUID(import_id), parse=_parse)

    status = await client.get(f"/api/imports/{import_id}", params={"workspace_id": ws})
    assert status.status_code == 200
    body = status.json()
    assert body["status"] == "ready"
    assert body["parser"] == "tbank_statement"
    assert body["preview"]["new_count"] == len(SAMPLE_STATEMENT.operations)

    committed = await client.post(
        f"/api/imports/{import_id}/commit", params={"workspace_id": ws}
    )
    assert committed.status_code == 200
    assert committed.json()["imported"] == len(SAMPLE_STATEMENT.operations)


async def test_commit_of_foreign_import_is_404(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Чужой импорт неотличим от несуществующего — одинаковый 404 и на статусе,
    и на коммите; иначе расхождение кодов само выдавало бы факт существования."""
    ws, acc = await _ws_and_account(client)
    monkeypatch.setattr("app.imports.router.extract_lines", lambda data: SAMPLE_LINES)
    started = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("s.pdf", b"%PDF-fake", "application/pdf")},
    )
    import_id = started.json()["import_id"]
    resp = await client.post(
        f"/api/imports/{import_id}/commit", params={"workspace_id": str(uuid.uuid4())}
    )
    assert resp.status_code in (403, 404)


async def test_commit_before_parse_is_409(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Свой импорт, но разбор ещё идёт — это состояние, а не отсутствие."""
    ws, acc = await _ws_and_account(client)
    monkeypatch.setattr("app.imports.router.extract_lines", lambda data: SAMPLE_LINES)
    started = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("s.pdf", b"%PDF-fake", "application/pdf")},
    )
    import_id = started.json()["import_id"]
    resp = await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})
    assert resp.status_code == 409


async def test_status_of_foreign_workspace_is_404(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws, acc = await _ws_and_account(client)
    monkeypatch.setattr("app.imports.router.extract_lines", lambda data: SAMPLE_LINES)
    started = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("s.pdf", b"%PDF-fake", "application/pdf")},
    )
    import_id = started.json()["import_id"]
    resp = await client.get(
        f"/api/imports/{import_id}", params={"workspace_id": str(uuid.uuid4())}
    )
    assert resp.status_code in (403, 404)
```

Существующие проверки 415 (неверный тип), 413 (большой файл), 404 (нет счёта) сохранить — они относятся к эндпоинту старта и продолжают работать.

`SAMPLE_LINES` — те же строки формата Т-Банка, что уже используются в файле; `SAMPLE_STATEMENT` — соответствующий `ParsedStatement` (можно импортировать из `tests/test_import_async_service.py` или объявить локально по тому же образцу).

- [ ] **Step 2: Прогнать — должны падать**

Run: `uv run pytest tests/test_imports_api.py -q`
Expected: FAIL — эндпоинты `GET /api/imports/{id}` и `POST /api/imports/{id}/commit` ещё не существуют, старт возвращает не 202.

- [ ] **Step 3: Переписать роутер**

Заменить содержимое `backend/app/imports/router.py`:

```python
import asyncio
import uuid
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.identity.deps import require_workspace_member
from app.identity.models import User
from app.imports import service
from app.imports.parser import extract_lines
from app.imports.schemas import ImportResultOut, ImportStartedOut, ImportStatusOut
from app.imports.tasks import enqueue_parse
from app.ledger import service as ledger_service

router = APIRouter(prefix="/api")
logger = structlog.get_logger()

# выписку целиком читаем в память — ограничиваем размер, чтобы аплоад не съел RAM
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"application/pdf", "application/octet-stream"}


@router.post("/imports", status_code=202)
async def start_import(
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    file: UploadFile,
) -> ImportStartedOut:
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail="Ожидается PDF-файл")
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Файл слишком большой (максимум 10 МБ)")
    if not await ledger_service.account_exists(db, workspace_id, account_id):
        raise HTTPException(status_code=404, detail="Счёт не найден")
    pdf_bytes = await file.read()
    try:
        # pypdf синхронный и CPU-bound: в event loop он подвесил бы все запросы воркера
        lines = await asyncio.to_thread(extract_lines, pdf_bytes)
    except Exception as exc:
        # битый/не-PDF файл: разбирать нечего, в фон не ставим. Тип пишем в лог —
        # иначе баг в нашем коде неотличим от кривого файла; сообщение не логируем,
        # оно может нести текст выписки
        logger.warning("import_extract_failed", error_type=type(exc).__name__)
        raise HTTPException(status_code=422, detail="Не удалось прочитать PDF") from None
    imp = await service.start_import(
        db, workspace_id, account_id, user.id, file.filename or "statement.pdf", lines
    )
    try:
        enqueue_parse(imp.id)
    except Exception as exc:
        # брокер недоступен: не оставляем строку с текстом выписки (PII) ждать reaper
        await service.mark_import_failed(
            db, imp.id, "Не удалось поставить разбор в очередь — попробуйте позже"
        )
        logger.warning(
            "import_enqueue_failed", import_id=str(imp.id), error_type=type(exc).__name__
        )
        raise HTTPException(status_code=503, detail="Сервис разбора недоступен") from None
    return ImportStartedOut(import_id=imp.id, status=imp.status)


@router.get("/imports/{import_id}")
async def import_status(
    import_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ImportStatusOut:
    status = await service.get_import_status(db, workspace_id, import_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Импорт не найден")
    return status


@router.post("/imports/{import_id}/commit")
async def commit_import(
    import_id: uuid.UUID,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ImportResultOut:
    try:
        return await service.commit_from_import(db, workspace_id, import_id, user.id)
    except service.ImportNotFoundError:
        raise HTTPException(status_code=404, detail="Импорт не найден") from None
    except service.ImportNotReadyError:
        raise HTTPException(status_code=409, detail="Импорт не готов к подтверждению") from None
```

**Про коды ответа (решено по итогам ревью Task 4):** различаем по *состоянию*, но не по
*владению*. «Не найден» и «чужой» дают одинаковый **404** — ровно как уже делает
статусный эндпоинт, поэтому существование чужого импорта не палится. Неверный
статус своего импорта (`processing`/`failed`) — **409**. Склеивать все три случая
в один код бессмысленно и даже вредно: `GET /imports/{id}` уже отдаёт 404 для
чужого, так что расхождение 404-на-GET vs 409-на-commit само различало бы случаи.
Фронту разделение нужно практически: 404 — тупик (прекратить поллинг), 409 —
ждать или показать ошибку.

Поэтому в `app/imports/service.py` разведи два исключения: оставь
`ImportNotReadyError` для неверного статуса и добавь рядом
`class ImportNotFoundError(Exception)`; в `commit_from_import` поднимай
`ImportNotFoundError`, когда `repository.get_import` вернул `None`, и
`ImportNotReadyError`, когда запись найдена, но `status != "ready"`
(с учётом идемпотентной ветки `completed`). Тесты Task 4, ожидающие
`ImportNotReadyError` для чужого импорта, поправь на `ImportNotFoundError`.

- [ ] **Step 4: Удалить синхронный поток из сервиса**

В `backend/app/imports/service.py` удалить функции `preview`, `commit_import`, `_parse`, `_check_control_sum` и константу `BANK_PROFILE`, а также ставшие ненужными импорты (`extract_lines`, `parse_statement`). Проверить, что `_external_ids` осталась (её использует новый код) и что `ParsedOperation`/`ParsedStatement` импортируются.

- [ ] **Step 5: Заглушить постановку задачи в тестах**

В `backend/tests/conftest.py` рядом с существующей autouse-фикстурой `stub_categorize_enqueue` добавить:

```python
@pytest.fixture(autouse=True)
def stub_parse_enqueue(monkeypatch: pytest.MonkeyPatch) -> list[uuid.UUID]:
    """Во всех тестах глушим реальную постановку разбора в очередь (иначе .delay
    пойдёт к брокеру). Тесты, которым важен факт триггера, читают этот список."""
    calls: list[uuid.UUID] = []
    monkeypatch.setattr("app.imports.router.enqueue_parse", lambda import_id: calls.append(import_id))
    return calls
```

- [ ] **Step 6: Прогнать весь набор**

Run: `uv run pytest -q`
Expected: PASS — без регрессий. Тесты, ссылавшиеся на удалённые `service.preview`/`service.commit_import` (в т.ч. `tests/test_import_dedup_service.py`), переписать на новый поток или удалить, если их сценарий уже покрыт `tests/test_import_async_service.py`. Не оставлять мёртвых тестов.

- [ ] **Step 7: Линт/типы/границы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports`
Expected: без ошибок; `Contracts: 7 kept, 0 broken`.

- [ ] **Step 8: Commit**

```bash
git add app/imports/router.py app/imports/service.py tests/conftest.py tests/test_imports_api.py tests/test_import_dedup_service.py
git commit -m "Импорт: API переведён на асинхронный поток (старт/статус/коммит), синхронный удалён"
```

---

## Task 7: Frontend — async-импорт с поллингом

**Files:**
- Modify: `frontend/src/api/imports.ts`
- Modify: `frontend/src/pages/ImportPage.tsx`
- Modify: `frontend/src/pages/ImportPreviewPanel.tsx`
- Modify: `frontend/src/pages/ImportPreviewPanel.test.tsx`

Команды из `frontend/`.

- [ ] **Step 1: Переписать API-модуль**

Заменить содержимое `frontend/src/api/imports.ts`:

```typescript
import { api, ApiError } from './client'

export interface ImportOperation {
  occurred_at: string
  amount: string
  currency: string
  description: string
  is_duplicate: boolean
}

export interface ImportPreview {
  operations: ImportOperation[]
  new_count: number
  duplicate_count: number
  total_income: string | null
  total_expense: string | null
}

export interface ImportStarted {
  import_id: string
  status: string
}

export interface ImportStatus {
  import_id: string
  // 'completed' обязателен: без него поллинг не увидит терминальное состояние
  // после коммита и будет опрашивать статус вечно
  status: 'processing' | 'ready' | 'failed' | 'completed'
  parser: string | null
  error: string | null
  warnings: string[]
  preview: ImportPreview | null
}

export interface ImportResult {
  import_id: string
  imported: number
  duplicates: number
}

// multipart: не выставляем Content-Type вручную — браузер сам добавит boundary
export async function startImport(
  ws: string,
  accountId: string,
  file: File,
): Promise<ImportStarted> {
  const form = new FormData()
  form.append('file', file)
  const qs = new URLSearchParams({ workspace_id: ws, account_id: accountId })
  const res = await fetch(`/api/imports?${qs.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body?.detail ?? res.statusText)
  }
  return res.json() as Promise<ImportStarted>
}

const q = (ws: string) => new URLSearchParams({ workspace_id: ws }).toString()

export const getImportStatus = (ws: string, id: string) =>
  api<ImportStatus>(`/api/imports/${id}?${q(ws)}`)

export const commitImport = (ws: string, id: string) =>
  api<ImportResult>(`/api/imports/${id}/commit?${q(ws)}`, { method: 'POST' })
```

- [ ] **Step 2: Показывать парсер и предупреждения в превью**

В `frontend/src/pages/ImportPreviewPanel.tsx` расширить props и шапку панели. Добавить в интерфейс props:

```typescript
  parser: string | null
  warnings: string[]
```

и отрисовать над таблицей (внутри существующего контейнера, до счётчиков):

```tsx
      {/* подпись по имени парсера: жёсткое «иначе Т-Банк» соврало бы, как только
          в реестре появится второй банк */}
      {parser && (
        <Badge variant="light" color={parser === 'llm' ? 'blue' : 'gray'}>
          {PARSER_LABELS[parser] ?? parser}
        </Badge>
      )}
      {warnings.map((w) => (
        <Alert key={w} color="yellow">{w}</Alert>
      ))}
```

(добавить `Badge`, `Alert` в импорт из `@mantine/core`, если их там нет.)

- [ ] **Step 3: Обновить тест панели**

В `frontend/src/pages/ImportPreviewPanel.test.tsx` в рендер добавить новые props и добавить тест:

```tsx
test('показывает бейдж AI-разбора и предупреждение', () => {
  render(
    <MantineProvider>
      <ImportPreviewPanel
        preview={preview}
        parser="llm"
        warnings={['Сумма расходов не сошлась с итогом выписки']}
        importing={false}
        imported={null}
        onImport={vi.fn()}
      />
    </MantineProvider>,
  )
  expect(screen.getByText('AI-разбор')).toBeDefined()
  expect(screen.getByText(/не сошлась/)).toBeDefined()
})
```

Существующие рендеры в файле дополнить `parser={null} warnings={[]}`, чтобы типы сходились.

- [ ] **Step 4: Перевести страницу импорта на поллинг**

Заменить содержимое `frontend/src/pages/ImportPage.tsx`:

```tsx
import { Alert, Button, Card, FileInput, Loader, Select, Stack, Text, Title } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { commitImport, getImportStatus, startImport } from '../api/imports'
import { getAccounts } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { ImportPreviewPanel } from './ImportPreviewPanel'

export function ImportPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [accountId, setAccountId] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [importId, setImportId] = useState<string | null>(null)

  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })

  // разбор идёт в фоне (Celery) — опрашиваем статус, пока он processing
  const { data: status } = useQuery({
    queryKey: ['import', ws, importId],
    queryFn: () => getImportStatus(ws, importId!),
    enabled: importId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'processing' ? 1500 : false,
  })

  const startMut = useMutation({
    mutationFn: () => startImport(ws, accountId!, file!),
    onSuccess: (res) => setImportId(res.import_id),
  })
  const commitMut = useMutation({
    mutationFn: () => commitImport(ws, importId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions', ws] })
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard', ws] })
    },
  })

  const reset = () => {
    setImportId(null)
    commitMut.reset()
  }

  return (
    <Stack>
      <Title order={2}>Импорт выписки</Title>
      <Card withBorder>
        <Stack>
          <Select
            label="Счёт"
            placeholder="Куда импортировать"
            data={(accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
            value={accountId}
            onChange={(v) => { setAccountId(v); reset() }}
          />
          <FileInput
            label="PDF-выписка"
            placeholder="Выберите файл"
            accept="application/pdf"
            value={file}
            onChange={(f) => { setFile(f); reset() }}
          />
          <Button
            disabled={!accountId || !file}
            loading={startMut.isPending}
            onClick={() => startMut.mutate()}
          >
            Разобрать
          </Button>
          {startMut.isError && <Alert color="red">Не удалось загрузить выписку</Alert>}
        </Stack>
      </Card>

      {status?.status === 'processing' && (
        <Card withBorder>
          <Stack align="center">
            <Loader />
            <Text>Разбираем выписку…</Text>
          </Stack>
        </Card>
      )}

      {status?.status === 'failed' && (
        <Alert color="red">{status.error ?? 'Не удалось разобрать выписку'}</Alert>
      )}

      {status?.status === 'ready' && status.preview && (
        <ImportPreviewPanel
          preview={status.preview}
          parser={status.parser}
          warnings={status.warnings}
          importing={commitMut.isPending}
          imported={commitMut.data?.imported ?? null}
          onImport={() => commitMut.mutate()}
        />
      )}
    </Stack>
  )
}
```

- [ ] **Step 5: Прогнать тесты, линт, типы**

Run (из `frontend/`): `pnpm test && pnpm lint && pnpm build`
Expected: тесты зелёные, oxlint чист, сборка/типы без ошибок.

- [ ] **Step 6: Commit**

```bash
git add src/api/imports.ts src/pages/ImportPage.tsx src/pages/ImportPreviewPanel.tsx src/pages/ImportPreviewPanel.test.tsx
git commit -m "Фронт: асинхронный импорт с поллингом статуса, бейдж парсера и предупреждения"
```

---

## Финальная проверка этапа

- [ ] **Backend целиком:** из `backend/` — `uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`. Всё зелёное.
- [ ] **Frontend целиком:** из `frontend/` — `pnpm test && pnpm lint && pnpm build`. Всё зелёное.
- [ ] **Живой прогон (ручной):** поднять стек (`docker compose`), задать в `.env` реальные `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL_PARSE`. Проверить: (1) PDF Т-Банка разбирается детерминированным парсером (бейдж «Т-Банк», LLM не вызывается); (2) выписка другого банка уходит в LLM-разбор (бейдж «AI-разбор»), операции создаются, автокатегоризация подхватывает их; (3) битый/непонятный файл даёт `failed` с понятным сообщением; (4) в логах воркера — только идентификаторы, без PII и сумм.
- [ ] **PR** после зелёного CI.
