# AI-автокатегоризация (этап 2a, v1 LLM-классификатор) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматически проставлять категорию операции по её описанию через LLM-классификатор: выше порога уверенности — авто (помечено «AI»), ниже — подсказка на подтверждение; запуск фоном в Celery после импорта/создания и по кнопке.

**Architecture:** Новый доменно-независимый модуль `app/ai/` (интерфейс `LLMClient` + OpenAI-совместимая реализация). Доменная логика категоризации живёт в `app/ledger/` (её таблицы), вызывает `ai.LLMClient` через интерфейс (`ledger → ai`). Классификация — Celery-задача; постановка в очередь — тонкая обёртка в `ledger.service`, дёргается роутером после ручного создания и модулем `imports` после коммита. Фидбек-луп v1 — few-shot из подтверждённых пар `merchant→категория`.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 async, Alembic, Celery/Redis, `openai` (OpenAI-совместимый клиент), structlog, pytest; фронт — React + Mantine + TanStack Query + vitest.

**Спека:** `docs/superpowers/specs/2026-07-09-etap-2a-autocategorization-design.md`.

**Существующие соглашения (важно для исполнителя):**
- Деньги — `Decimal`/`NUMERIC(20,4)`, `float` запрещён везде. Уверенность (`category_confidence`) — не деньги, но по стилю проекта тоже `Decimal`/`NUMERIC(4,3)`, не `float`.
- Каждый запрос фильтрует по `workspace_id` в repository-слое. Утечка между workspace — критический баг.
- Комментарии/коммиты — на русском; без `Co-Authored-By`. Комментарий объясняет «почему».
- В логи — только идентификаторы, без PII (описаний) и сумм.
- Целевой каталог для команд: `backend/` (там `pyproject.toml`, `alembic.ini`). Команды ниже — из `backend/`.
- Проверки перед коммитом задачи: `uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest <относящиеся тесты>`.

---

## Карта файлов

Создаются:
- `backend/app/ai/__init__.py` — пакет `ai`.
- `backend/app/ai/client.py` — `LLMClient` (Protocol), `OpenAICompatLLMClient`, `build_llm_client()`.
- `backend/app/ledger/categorization.py` — чистая логика: кандидаты, промпт, разбор ответа, порог, оркестрация прохода.
- `backend/app/ledger/tasks.py` — Celery-задача `categorize_workspace` + `enqueue_categorize`.
- `backend/alembic/versions/0006_categorization.py` — миграция полей.
- `backend/tests/test_ai_client.py`, `backend/tests/test_categorization.py`, `backend/tests/test_categorize_repository.py`, `backend/tests/test_categorize_api.py`, `backend/tests/test_categorize_trigger.py`, `backend/tests/test_categorize_eval.py`.
- `backend/tests/data/categorize_eval.json` — размеченный eval-набор.
- `backend/scripts/eval_categorize.py` — раннер accuracy против живого провайдера (ручной).
- `frontend/src/pages/CategoryCell.tsx` + `frontend/src/pages/CategoryCell.test.tsx` — ячейка категории с бейджем/подсказкой.

Модифицируются:
- `backend/app/core/settings.py` — настройки LLM/порога/few-shot.
- `backend/app/ledger/models.py` — поля `category_confirmed`, `category_confidence`, `suggested_category_id`.
- `backend/app/ledger/repository.py` — `list_uncategorized`, `recent_confirmed_pairs`.
- `backend/app/ledger/service.py` — `enqueue_categorization`, правка `update_transaction`, `dismiss_suggestion`.
- `backend/app/ledger/schemas.py` — поля в `TransactionOut`.
- `backend/app/ledger/router.py` — автотриггер, эндпоинты `categorize` и `dismiss-suggestion`.
- `backend/app/imports/service.py` — автотриггер после коммита импорта.
- `backend/app/core/celery_app.py` — autodiscover `app.ledger`.
- `backend/pyproject.toml` — зависимость `openai`, контракт import-linter для `ai`.
- `backend/tests/conftest.py` — autouse-фикстура, глушащая постановку задачи в очередь.
- `frontend/src/api/ledger.ts` — поля `Transaction`, `dismissSuggestion`, `categorizeUncategorized`.
- `frontend/src/pages/TransactionsPage.tsx` — колонка категории через `CategoryCell`, кнопка категоризации.

---

## Task 1: Модуль `ai` — интерфейс LLMClient, OpenAI-совместимая реализация, конфиг

**Files:**
- Modify: `backend/pyproject.toml` (добавить зависимость `openai`)
- Modify: `backend/app/core/settings.py`
- Create: `backend/app/ai/__init__.py`
- Create: `backend/app/ai/client.py`
- Test: `backend/tests/test_ai_client.py`

- [ ] **Step 1: Добавить зависимость `openai`**

В `backend/pyproject.toml` в список `dependencies` добавить строку (после `python-multipart`):

```toml
    "openai>=1.55",
```

Затем установить: `uv sync`.

- [ ] **Step 2: Расширить настройки LLM**

Заменить содержимое `backend/app/core/settings.py`:

```python
from decimal import Decimal
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://aiccountant:change-me@localhost:5432/aiccountant"
    redis_url: str = "redis://localhost:6379/0"
    session_ttl_days: int = 30
    cookie_secure: bool = False
    allowed_origins: list[str] = ["http://localhost:5173"]

    # LLM-слой: OpenAI-совместимый эндпоинт (облако по умолчанию; Ollama — иной base_url)
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model_categorize: str = "gpt-4o-mini"
    # порог уверенности: выше — авто-простановка, ниже — подсказка на подтверждение
    categorize_confidence_threshold: Decimal = Decimal("0.8")
    # сколько подтверждённых примеров merchant→категория подмешивать в промпт (few-shot)
    categorize_fewshot_limit: int = 10


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 3: Написать падающий тест интерфейса и реализации**

Создать `backend/tests/test_ai_client.py`:

```python
import json

import pytest

from app.ai.client import LLMClient, OpenAICompatLLMClient


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str) -> None:
        self.message = _FakeMessage(content)


class _FakeCompletion:
    def __init__(self, content: str) -> None:
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, content: str) -> None:
        self._content = content
        self.calls: list[dict[str, object]] = []

    async def create(self, **kwargs: object) -> _FakeCompletion:
        self.calls.append(kwargs)
        return _FakeCompletion(self._content)


class _FakeChat:
    def __init__(self, content: str) -> None:
        self.completions = _FakeCompletions(content)


class _FakeOpenAI:
    """Заглушка AsyncOpenAI: возвращает записанный ответ, минуя сеть."""

    def __init__(self, content: str) -> None:
        self.chat = _FakeChat(content)


async def test_complete_json_returns_message_content() -> None:
    recorded = json.dumps({"category": "Еда", "confidence": 0.91})
    fake = _FakeOpenAI(recorded)
    client: LLMClient = OpenAICompatLLMClient(fake, "test-model")  # type: ignore[arg-type]

    result = await client.complete_json(system="сис", user="польз")

    assert json.loads(result) == {"category": "Еда", "confidence": 0.91}
    # модель и режим JSON переданы провайдеру
    call = fake.chat.completions.calls[0]
    assert call["model"] == "test-model"
    assert call["response_format"] == {"type": "json_object"}


async def test_complete_json_none_content_falls_back_to_empty_object() -> None:
    fake = _FakeOpenAI(None)  # type: ignore[arg-type]
    client = OpenAICompatLLMClient(fake, "test-model")  # type: ignore[arg-type]
    assert await client.complete_json(system="s", user="u") == "{}"
```

- [ ] **Step 4: Прогнать тест — должен падать**

Run: `uv run pytest tests/test_ai_client.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.ai'`.

- [ ] **Step 5: Создать пакет и реализацию**

Создать `backend/app/ai/__init__.py` (пустой файл).

Создать `backend/app/ai/client.py`:

```python
from typing import Protocol

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from app.core.settings import get_settings


class LLMClient(Protocol):
    """Провайдеро-независимый интерфейс LLM. Реализации — только в модуле ai."""

    async def complete_json(self, *, system: str, user: str) -> str:
        """Вернуть ответ модели как JSON-текст (провайдер обязан вернуть валидный JSON)."""
        ...


class OpenAICompatLLMClient:
    """Реализация через OpenAI-совместимый эндпоинт (OpenAI, OpenRouter, DeepSeek,
    Gemini-compat, локальный Ollama — отличаются лишь base_url/модель)."""

    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def complete_json(self, *, system: str, user: str) -> str:
        messages: list[ChatCompletionMessageParam] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        resp = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0,
        )
        return resp.choices[0].message.content or "{}"


def build_llm_client() -> OpenAICompatLLMClient:
    settings = get_settings()
    client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key or "unset")
    return OpenAICompatLLMClient(client, settings.llm_model_categorize)
```

- [ ] **Step 6: Прогнать тест — должен проходить**

Run: `uv run pytest tests/test_ai_client.py -q`
Expected: PASS (2 passed).

- [ ] **Step 7: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок. (Если mypy не находит типы `openai` — они поставляются пакетом; убедиться, что `openai` установлен.)

- [ ] **Step 8: Commit**

```bash
git add backend/app/ai backend/app/core/settings.py backend/pyproject.toml backend/uv.lock backend/tests/test_ai_client.py
git commit -m "AI: модуль ai — интерфейс LLMClient и OpenAI-совместимая реализация"
```

---

## Task 2: Поля категоризации в модели и миграция 0006

**Files:**
- Modify: `backend/app/ledger/models.py:34-69`
- Create: `backend/alembic/versions/0006_categorization.py`
- Test: `backend/tests/test_categorize_repository.py` (первый тест — про дефолты полей)

- [ ] **Step 1: Падающий тест дефолтов новых полей**

Создать `backend/tests/test_categorize_repository.py`:

```python
import uuid
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import service

ALICE = {"email": "alice@example.com", "password": "password123"}


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


async def test_new_transaction_has_categorization_defaults(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    txn = await service.post_transaction(
        db_session, ws, user_id,
        account_id=acc, category_id=None,
        amount=Decimal("-100.00"), occurred_at=date(2026, 7, 5), source="import",
    )
    await db_session.commit()
    assert txn.category_confirmed is False
    assert txn.category_confidence is None
    assert txn.suggested_category_id is None
```

- [ ] **Step 2: Прогнать — должен падать**

Run: `uv run pytest tests/test_categorize_repository.py::test_new_transaction_has_categorization_defaults -q`
Expected: FAIL — `AttributeError: 'Transaction' object has no attribute 'category_confirmed'`.

- [ ] **Step 3: Добавить поля в модель**

В `backend/app/ledger/models.py` в класс `Transaction` после строки с `import_id` (перед `created_by`) добавить:

```python
    # AI-категоризация: подтвердил ли человек текущую категорию (авто-простановка = false)
    category_confirmed: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    # уверенность последнего прогона классификатора (0..1); NUMERIC, не float
    category_confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3), nullable=True)
    # предложение классификатора ниже порога (категория ещё не применена)
    suggested_category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id"), nullable=True
    )
```

(`Numeric`, `ForeignKey`, `text` уже импортированы в файле.)

- [ ] **Step 4: Написать миграцию 0006**

Создать `backend/alembic/versions/0006_categorization.py`:

```python
"""Поля AI-категоризации в transactions"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column(
            "category_confirmed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "transactions",
        sa.Column("category_confidence", sa.Numeric(4, 3), nullable=True),
    )
    op.add_column(
        "transactions",
        sa.Column("suggested_category_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_transactions_suggested_category_id_categories"),
        "transactions",
        "categories",
        ["suggested_category_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_transactions_suggested_category_id_categories"),
        "transactions",
        type_="foreignkey",
    )
    op.drop_column("transactions", "suggested_category_id")
    op.drop_column("transactions", "category_confidence")
    op.drop_column("transactions", "category_confirmed")
```

- [ ] **Step 5: Прогнать тест — должен проходить**

Run: `uv run pytest tests/test_categorize_repository.py::test_new_transaction_has_categorization_defaults -q`
Expected: PASS. (Фикстура `db_session` поднимает контейнер и применяет миграции до head, включая 0006.)

- [ ] **Step 6: Проверить, что связка миграций цела**

Run: `uv run pytest tests/test_migrations.py -q`
Expected: PASS.

- [ ] **Step 7: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 8: Commit**

```bash
git add backend/app/ledger/models.py backend/alembic/versions/0006_categorization.py backend/tests/test_categorize_repository.py
git commit -m "Ledger: поля AI-категоризации (confirmed/confidence/suggested) + миграция 0006"
```

---

## Task 3: Repository — запросы для категоризации

**Files:**
- Modify: `backend/app/ledger/repository.py`
- Test: `backend/tests/test_categorize_repository.py`

- [ ] **Step 1: Падающий тест выборки некатегоризированных и few-shot пар**

В `backend/tests/test_categorize_repository.py` добавить в конец:

```python
from app.ledger import repository


async def test_list_uncategorized_excludes_categorized_suggested_and_transfers(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food = next(c for c in cats if c.name == "Еда")

    # без категории — попадёт
    plain = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-10.00"), occurred_at=date(2026, 7, 5), source="import",
        merchant="Пятёрочка",
    )
    # уже с категорией — не попадёт
    await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=food.id,
        amount=Decimal("-20.00"), occurred_at=date(2026, 7, 5), source="manual",
    )
    # с активной подсказкой — не попадёт
    suggested = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-30.00"), occurred_at=date(2026, 7, 5), source="import",
    )
    suggested.suggested_category_id = food.id
    await db_session.commit()

    rows = await repository.list_uncategorized(db_session, ws)
    ids = {t.id for t in rows}
    assert plain.id in ids
    assert suggested.id not in ids
    assert len(ids) == 1


async def test_recent_confirmed_pairs_only_confirmed_matching_kind(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food = next(c for c in cats if c.name == "Еда")
    salary = next(c for c in cats if c.name == "Зарплата")

    confirmed = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=food.id,
        amount=Decimal("-40.00"), occurred_at=date(2026, 7, 5), source="manual",
        merchant="Магнит",
    )
    confirmed.category_confirmed = True
    # income-подтверждённая — не должна попасть в expense-few-shot
    inc = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=salary.id,
        amount=Decimal("1000.00"), occurred_at=date(2026, 7, 5), source="manual",
        merchant="ООО Ромашка",
    )
    inc.category_confirmed = True
    await db_session.commit()

    pairs = await repository.recent_confirmed_pairs(db_session, ws, "expense", 10)
    assert ("Магнит", "Еда") in pairs
    assert all(name != "Зарплата" for _, name in pairs)
```

- [ ] **Step 2: Прогнать — должен падать**

Run: `uv run pytest tests/test_categorize_repository.py -q`
Expected: FAIL — `AttributeError: module 'app.ledger.repository' has no attribute 'list_uncategorized'`.

- [ ] **Step 3: Реализовать запросы**

В `backend/app/ledger/repository.py` добавить в конец файла:

```python
async def list_uncategorized(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[Transaction]:
    """Операции без категории и без активной подсказки; переводы не трогаем."""
    rows = await db.execute(
        select(Transaction).where(
            Transaction.workspace_id == workspace_id,
            Transaction.category_id.is_(None),
            Transaction.suggested_category_id.is_(None),
            Transaction.transfer_group_id.is_(None),
        )
    )
    return list(rows.scalars().all())


async def recent_confirmed_pairs(
    db: AsyncSession, workspace_id: uuid.UUID, kind: str, limit: int
) -> list[tuple[str, str]]:
    """Последние подтверждённые человеком пары merchant→имя категории нужного kind
    — few-shot для промпта (фидбек-луп v1)."""
    rows = await db.execute(
        select(Transaction.merchant, Category.name)
        .join(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.category_confirmed.is_(True),
            Transaction.merchant.is_not(None),
            Category.kind == kind,
        )
        .order_by(Transaction.created_at.desc())
        .limit(limit)
    )
    return [(m, n) for m, n in rows.all() if m is not None]
```

- [ ] **Step 4: Прогнать — должен проходить**

Run: `uv run pytest tests/test_categorize_repository.py -q`
Expected: PASS (все тесты файла).

- [ ] **Step 5: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add backend/app/ledger/repository.py backend/tests/test_categorize_repository.py
git commit -m "Ledger: запросы list_uncategorized и recent_confirmed_pairs для категоризации"
```

---

## Task 4: Чистая логика классификации — кандидаты, разбор ответа, порог

**Files:**
- Create: `backend/app/ledger/categorization.py`
- Test: `backend/tests/test_categorization.py`

- [ ] **Step 1: Падающие юнит-тесты чистых функций**

Создать `backend/tests/test_categorization.py`:

```python
import json
import uuid
from decimal import Decimal

from app.ledger import categorization as c
from app.ledger.models import Category


def _cat(name: str, kind: str) -> Category:
    cat = Category(name=name, kind=kind)
    cat.id = uuid.uuid4()
    return cat


def test_choose_candidates_filters_by_sign() -> None:
    cats = [_cat("Еда", "expense"), _cat("Зарплата", "income")]
    assert [x.name for x in c.choose_candidates(cats, Decimal("-5"))] == ["Еда"]
    assert [x.name for x in c.choose_candidates(cats, Decimal("5"))] == ["Зарплата"]


def test_parse_answer_valid_name_and_confidence() -> None:
    raw = json.dumps({"category": "Еда", "confidence": 0.95})
    name, conf = c.parse_answer(raw, {"Еда", "Транспорт"})
    assert name == "Еда"
    assert conf == Decimal("0.950")


def test_parse_answer_unknown_name_becomes_none() -> None:
    raw = json.dumps({"category": "Криптовалюта", "confidence": 0.99})
    name, conf = c.parse_answer(raw, {"Еда"})
    assert name is None


def test_parse_answer_broken_json_is_none_zero() -> None:
    name, conf = c.parse_answer("не json", {"Еда"})
    assert name is None
    assert conf == Decimal("0")


def test_parse_answer_confidence_clamped() -> None:
    _, conf = c.parse_answer(json.dumps({"category": "Еда", "confidence": 5}), {"Еда"})
    assert conf == Decimal("1.000")


def test_decide_apply_above_threshold() -> None:
    by_name = {"Еда": uuid.uuid4()}
    d = c.decide("Еда", Decimal("0.9"), Decimal("0.8"), by_name)
    assert d.kind == "apply"
    assert d.category_id == by_name["Еда"]


def test_decide_suggest_below_threshold() -> None:
    by_name = {"Еда": uuid.uuid4()}
    d = c.decide("Еда", Decimal("0.5"), Decimal("0.8"), by_name)
    assert d.kind == "suggest"
    assert d.category_id == by_name["Еда"]


def test_decide_none_when_no_name() -> None:
    d = c.decide(None, Decimal("0"), Decimal("0.8"), {})
    assert d.kind == "none"
    assert d.category_id is None
```

- [ ] **Step 2: Прогнать — должен падать**

Run: `uv run pytest tests/test_categorization.py -q`
Expected: FAIL — `ModuleNotFoundError` / нет функций.

- [ ] **Step 3: Реализовать чистые функции**

Создать `backend/app/ledger/categorization.py`:

```python
import json
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.client import LLMClient
from app.ledger import repository
from app.ledger.models import Category

logger = structlog.get_logger()

SYSTEM_PROMPT = (
    "Ты помощник по учёту личных финансов. По описанию операции выбери ОДНУ "
    "категорию строго из предложенного списка. Если ни одна не подходит — верни null. "
    'Ответ только JSON: {"category": <имя из списка или null>, "confidence": <число 0..1>}.'
)


def kind_for_amount(amount: Decimal) -> str:
    return "expense" if amount < 0 else "income"


def choose_candidates(categories: list[Category], amount: Decimal) -> list[Category]:
    kind = kind_for_amount(amount)
    return [cat for cat in categories if cat.kind == kind]


def build_user_prompt(
    description: str, candidate_names: list[str], examples: list[tuple[str, str]]
) -> str:
    parts = [f"Категории: {', '.join(candidate_names)}."]
    if examples:
        sample = "; ".join(f"«{m}» → {n}" for m, n in examples)
        parts.append(f"Примеры прошлых решений: {sample}.")
    parts.append(f"Описание операции: «{description}».")
    return "\n".join(parts)


def parse_answer(raw: str, candidate_names: set[str]) -> tuple[str | None, Decimal]:
    """Разобрать JSON-ответ модели: валидное имя из кандидатов + уверенность 0..1.
    Любой сбой разбора — «нет категории», не падаем."""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None, Decimal(0)
    if not isinstance(data, dict):
        return None, Decimal(0)
    name = data.get("category")
    # имя от модели может быть чем угодно (list/dict/число) — членство в set
    # проверяем только для строк, иначе «нет категории»
    if not isinstance(name, str) or name not in candidate_names:
        name = None
    try:
        confidence = Decimal(str(data.get("confidence", 0))).quantize(Decimal("0.001"))
    except (InvalidOperation, TypeError, ValueError):
        confidence = Decimal(0)
    # нечисловые/бесконечные значения (например "NaN") в min/max бросают InvalidOperation
    if not confidence.is_finite():
        confidence = Decimal(0)
    confidence = max(Decimal(0), min(Decimal(1), confidence))
    return name, confidence


@dataclass
class Decision:
    kind: str  # 'apply' | 'suggest' | 'none'
    category_id: uuid.UUID | None
    confidence: Decimal


def decide(
    name: str | None,
    confidence: Decimal,
    threshold: Decimal,
    by_name: dict[str, uuid.UUID],
) -> Decision:
    if name is None:
        return Decision("none", None, confidence)
    category_id = by_name[name]
    if confidence >= threshold:
        return Decision("apply", category_id, confidence)
    return Decision("suggest", category_id, confidence)


async def classify_one(
    llm: LLMClient,
    description: str,
    candidates: list[Category],
    examples: list[tuple[str, str]],
) -> tuple[str | None, Decimal]:
    names = [cat.name for cat in candidates]
    raw = await llm.complete_json(
        system=SYSTEM_PROMPT,
        user=build_user_prompt(description, names, examples),
    )
    return parse_answer(raw, set(names))


async def categorize_uncategorized(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    llm: LLMClient,
    *,
    threshold: Decimal,
    fewshot_limit: int,
) -> int:
    """Пройти по некатегоризированным операциям workspace и применить решение
    классификатора (авто/подсказка). Возвращает число обработанных."""
    categories = await repository.list_categories(db, workspace_id)
    transactions = await repository.list_uncategorized(db, workspace_id)
    processed = 0
    for txn in transactions:
        candidates = choose_candidates(categories, txn.amount)
        if not candidates:
            continue
        kind = kind_for_amount(txn.amount)
        examples = await repository.recent_confirmed_pairs(db, workspace_id, kind, fewshot_limit)
        try:
            name, confidence = await classify_one(llm, txn.merchant or "", candidates, examples)
        except Exception:
            # провайдер недоступен/ошибка — операция остаётся без категории, не падаем
            logger.warning("categorize_failed", transaction_id=str(txn.id))
            continue
        by_name = {cat.name: cat.id for cat in candidates}
        decision = decide(name, confidence, threshold, by_name)
        txn.category_confidence = decision.confidence
        if decision.kind == "apply":
            txn.category_id = decision.category_id
            txn.category_confirmed = False
        elif decision.kind == "suggest":
            txn.suggested_category_id = decision.category_id
        logger.info("categorized", transaction_id=str(txn.id), decision=decision.kind)
        processed += 1
    await db.commit()
    return processed
```

**Примечание по стилю:** `except Exception` здесь осознанно широкий (сетевой сбой провайдера не должен ронять весь проход), но он не «глотает молча» — пишет `logger.warning` с идентификатором и пропускает операцию. Это соответствует §9 спеки.

- [ ] **Step 4: Прогнать — должен проходить**

Run: `uv run pytest tests/test_categorization.py -q`
Expected: PASS (все юнит-тесты).

- [ ] **Step 5: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок. (Если ruff ругается на `except Exception` через правило `BLE001` — оно не включено в конфиге проекта, `select = E,F,I,UP,B,SIM`; трогать не нужно.)

- [ ] **Step 6: Commit**

```bash
git add backend/app/ledger/categorization.py backend/tests/test_categorization.py
git commit -m "Ledger: логика классификации (кандидаты, разбор ответа, порог, проход)"
```

---

## Task 5: Интеграция прохода категоризации с БД (FakeLLMClient)

**Files:**
- Test: `backend/tests/test_categorization.py` (добавить интеграционные тесты)

Цель — проверить `categorize_uncategorized` целиком на реальной БД (`db_session`), подставляя записанные ответы LLM через фейковый `LLMClient`. Кода приложения тут не меняем — только тесты.

- [ ] **Step 1: Добавить интеграционные тесты**

В `backend/tests/test_categorization.py` добавить в конец:

```python
from datetime import date

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository, service

ALICE = {"email": "alice@example.com", "password": "password123"}


class FakeLLM:
    """LLMClient с очередью записанных ответов (по одному на операцию)."""

    def __init__(self, answers: list[str]) -> None:
        self._answers = list(answers)
        self.prompts: list[str] = []

    async def complete_json(self, *, system: str, user: str) -> str:
        self.prompts.append(user)
        return self._answers.pop(0)


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


async def test_categorize_applies_above_and_suggests_below_threshold(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    high = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-100.00"), occurred_at=date(2026, 7, 5), source="import",
        merchant="Пятёрочка",
    )
    low = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-200.00"), occurred_at=date(2026, 7, 5), source="import",
        merchant="Непонятный мерчант",
    )
    await db_session.commit()

    llm = FakeLLM([
        json.dumps({"category": "Еда", "confidence": 0.95}),
        json.dumps({"category": "Еда", "confidence": 0.4}),
    ])
    processed = await categorization.categorize_uncategorized(
        db_session, ws, llm, threshold=Decimal("0.8"), fewshot_limit=10
    )
    assert processed == 2

    await db_session.refresh(high)
    await db_session.refresh(low)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")

    # выше порога — авто-простановка, не подтверждена человеком
    assert high.category_id == food_id
    assert high.category_confirmed is False
    assert high.category_confidence == Decimal("0.950")
    assert high.suggested_category_id is None
    # ниже порога — только подсказка
    assert low.category_id is None
    assert low.suggested_category_id == food_id
    assert low.category_confidence == Decimal("0.400")


async def test_categorize_leaves_uncategorized_on_broken_answer(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    txn = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-50.00"), occurred_at=date(2026, 7, 5), source="import",
        merchant="Что-то",
    )
    await db_session.commit()

    llm = FakeLLM(["это не json"])
    await categorization.categorize_uncategorized(
        db_session, ws, llm, threshold=Decimal("0.8"), fewshot_limit=10
    )
    await db_session.refresh(txn)
    assert txn.category_id is None
    assert txn.suggested_category_id is None


async def test_categorize_isolates_workspaces(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    # alice: своя операция без категории, её категоризацию НЕ запускаем
    alice_id, ws_alice, acc_alice = await _bootstrap(client)
    alice_txn = await service.post_transaction(
        db_session, ws_alice, alice_id, account_id=acc_alice, category_id=None,
        amount=Decimal("-100.00"), occurred_at=date(2026, 7, 5), source="import",
        merchant="Алисина еда",
    )
    # bob: свой workspace и операция без категории
    bob = {"email": "bob@example.com", "password": "password123"}
    reg2 = await client.post("/api/auth/register", json=bob)
    bob_id = uuid.UUID(reg2.json()["id"])
    me2 = await client.get("/api/me")  # активна сессия только что залогиненного bob
    ws_bob = uuid.UUID(me2.json()["workspaces"][0]["id"])
    acc_bob = uuid.UUID(
        (
            await client.post(
                "/api/accounts",
                params={"workspace_id": str(ws_bob)},
                json={"name": "Нал", "type": "cash", "currency": "RUB"},
            )
        ).json()["id"]
    )
    bob_txn = await service.post_transaction(
        db_session, ws_bob, bob_id, account_id=acc_bob, category_id=None,
        amount=Decimal("-50.00"), occurred_at=date(2026, 7, 5), source="import",
        merchant="Бобова еда",
    )
    await db_session.commit()

    # категоризируем ТОЛЬКО workspace bob
    llm = FakeLLM([json.dumps({"category": "Еда", "confidence": 0.95})])
    processed = await categorization.categorize_uncategorized(
        db_session, ws_bob, llm, threshold=Decimal("0.8"), fewshot_limit=10
    )
    assert processed == 1

    cats_bob = await repository.list_categories(db_session, ws_bob)
    food_bob = next(cat.id for cat in cats_bob if cat.name == "Еда")

    await db_session.refresh(bob_txn)
    await db_session.refresh(alice_txn)
    # операция bob категоризирована
    assert bob_txn.category_id == food_bob
    # операция alice не затронута — реальная проверка изоляции по workspace_id
    assert alice_txn.category_id is None
    assert alice_txn.suggested_category_id is None
    assert alice_txn.category_confidence is None
```

**Замечание по изоляции:** категоризируем реальный населённый workspace `bob` и проверяем, что операция `alice` осталась нетронутой, а операция `bob` — категоризирована. Так путь записи реально исполняется под фильтром `workspace_id` (сильнее, чем прогон по пустому/случайному ws). Регистрация второго пользователя перелогинивает сессию на `bob`, поэтому `/api/me` вернёт его workspace — это ожидаемо.

- [ ] **Step 2: Прогнать — должны проходить**

Run: `uv run pytest tests/test_categorization.py -q`
Expected: PASS.

- [ ] **Step 3: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_categorization.py
git commit -m "Тесты: проход категоризации на записанных ответах (авто/подсказка/сбой/изоляция)"
```

---

## Task 6: Celery-задача, постановка в очередь, автотриггеры

**Files:**
- Create: `backend/app/ledger/tasks.py`
- Modify: `backend/app/core/celery_app.py:24` (autodiscover) и блок импорта моделей
- Modify: `backend/app/ledger/service.py` (обёртка `enqueue_categorization`)
- Modify: `backend/app/ledger/router.py` (триггер после ручного создания)
- Modify: `backend/app/imports/service.py` (триггер после коммита импорта)
- Modify: `backend/tests/conftest.py` (autouse-фикстура, глушащая очередь)
- Test: `backend/tests/test_categorize_trigger.py`, `backend/tests/test_celery_bootstrap.py`

- [ ] **Step 1: Celery-задача и постановка в очередь**

Создать `backend/app/ledger/tasks.py`:

```python
import asyncio
import uuid

from app.ai.client import build_llm_client
from app.core.celery_app import celery_app
from app.core.db import session_factory
from app.core.settings import get_settings
from app.ledger import categorization


# decorator без типов из celery (ignore_missing_imports) → помечаем явно
@celery_app.task(name="ledger.categorize_workspace")  # type: ignore[untyped-decorator]
def categorize_workspace(workspace_id: str) -> int:
    """Тонкая обёртка: доменная логика — в categorization."""
    return asyncio.run(_run(uuid.UUID(workspace_id)))


async def _run(workspace_id: uuid.UUID) -> int:
    settings = get_settings()
    llm = build_llm_client()
    async with session_factory() as db:
        return await categorization.categorize_uncategorized(
            db,
            workspace_id,
            llm,
            threshold=settings.categorize_confidence_threshold,
            fewshot_limit=settings.categorize_fewshot_limit,
        )


def enqueue_categorize(workspace_id: uuid.UUID) -> None:
    """Поставить фоновую категоризацию workspace в очередь Celery."""
    categorize_workspace.delay(str(workspace_id))
```

- [ ] **Step 2: Зарегистрировать задачи ledger в Celery**

В `backend/app/core/celery_app.py` заменить строку autodiscover:

```python
celery_app.autodiscover_tasks(["app.recurring"])
```

на:

```python
celery_app.autodiscover_tasks(["app.recurring", "app.ledger"])
```

(Импорт `app.ledger.models` в конце файла уже есть — оставить.)

- [ ] **Step 3: Обёртка в сервисе ledger**

В `backend/app/ledger/service.py` добавить импорт вверху (рядом с другими импортами `app.ledger`):

```python
from app.ledger.tasks import enqueue_categorize
```

и функцию (например, после `account_exists`):

```python
def enqueue_categorization(workspace_id: uuid.UUID) -> None:
    """Публичная точка постановки категоризации в очередь — её зовут роутер и
    модуль imports; так границы соблюдены (imports ходит только в ledger.service)."""
    enqueue_categorize(workspace_id)
```

- [ ] **Step 4: Автотриггер после ручного создания операции**

В `backend/app/ledger/router.py` в `create_transaction` после успешного создания, перед `return`, добавить постановку в очередь, если категория не проставлена:

```python
    if transaction.category_id is None:
        service.enqueue_categorization(workspace_id)
    return _transaction_out(transaction)
```

(Заменить одиночный `return _transaction_out(transaction)` на этот блок.)

- [ ] **Step 5: Автотриггер после коммита импорта**

В `backend/app/imports/service.py` в конце `commit_import`, после `await db.commit()`, перед `return`, добавить:

```python
    if imported:
        ledger_service.enqueue_categorization(workspace_id)
```

- [ ] **Step 6: Autouse-фикстура в conftest, глушащая очередь**

В `backend/tests/conftest.py` добавить (после существующих фикстур):

```python
@pytest.fixture(autouse=True)
def stub_categorize_enqueue(monkeypatch: pytest.MonkeyPatch) -> list[uuid.UUID]:
    """Во всех тестах глушим реальную постановку задачи в очередь (иначе .delay
    пойдёт к брокеру). Тесты, которым важен факт триггера, читают этот список."""
    calls: list[uuid.UUID] = []
    monkeypatch.setattr(
        "app.ledger.service.enqueue_categorization", lambda ws: calls.append(ws)
    )
    return calls
```

Добавить импорт `uuid` вверху `conftest.py`, если его там нет.

**Важно:** и роутер (`service.enqueue_categorization`), и `imports.service` (`ledger_service.enqueue_categorization`) обращаются к одному и тому же атрибуту модуля `app.ledger.service`, поэтому один monkeypatch перехватывает оба вызова.

- [ ] **Step 7: Тест автотриггеров**

Создать `backend/tests/test_categorize_trigger.py`:

```python
import uuid

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = me.json()["workspaces"][0]["id"]
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def test_manual_create_without_category_enqueues(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, acc = await _ws_and_account(client)
    await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": acc, "amount": "-100.00", "occurred_at": "2026-07-05"},
    )
    assert uuid.UUID(ws) in stub_categorize_enqueue


async def test_manual_create_with_category_does_not_enqueue(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, acc = await _ws_and_account(client)
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c["id"] for c in cats if c["name"] == "Еда")
    await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={
            "account_id": acc,
            "category_id": food,
            "amount": "-100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert stub_categorize_enqueue == []


async def test_categorize_endpoint_enqueues(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, _ = await _ws_and_account(client)
    resp = await client.post("/api/transactions/categorize", params={"workspace_id": ws})
    assert resp.status_code == 202
    assert uuid.UUID(ws) in stub_categorize_enqueue
```

(Эндпоинт `/api/transactions/categorize` появится в Task 7 — тест `test_categorize_endpoint_enqueues` до него будет падать с 404/405. Запускать этот конкретный тест после Task 7; первые два — уже сейчас.)

- [ ] **Step 8: Расширить bootstrap-тест воркера**

В `backend/tests/test_celery_bootstrap.py` в строке-проверке добавить регистрацию задачи ledger. Заменить строку с `assert celery_app.main == 'aiccountant'\n` на:

```python
        "assert celery_app.main == 'aiccountant'\n"
        "assert 'ledger.categorize_workspace' in celery_app.tasks\n"
```

- [ ] **Step 9: Прогнать тесты**

Run: `uv run pytest tests/test_celery_bootstrap.py tests/test_categorize_trigger.py::test_manual_create_without_category_enqueues tests/test_categorize_trigger.py::test_manual_create_with_category_does_not_enqueue tests/test_transactions_api.py -q`
Expected: PASS. (Тесты транзакций проверяем, чтобы autouse-фикстура не сломала существующее создание операций.)

- [ ] **Step 10: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 11: Commit**

```bash
git add backend/app/ledger/tasks.py backend/app/core/celery_app.py backend/app/ledger/service.py backend/app/ledger/router.py backend/app/imports/service.py backend/tests/conftest.py backend/tests/test_categorize_trigger.py backend/tests/test_celery_bootstrap.py
git commit -m "Категоризация: Celery-задача, постановка в очередь и автотриггеры после импорта/создания"
```

---

## Task 7: Схема ответа, подтверждение/сброс подсказки, эндпоинты

**Files:**
- Modify: `backend/app/ledger/schemas.py:77-87`
- Modify: `backend/app/ledger/service.py` (`update_transaction`, `dismiss_suggestion`)
- Modify: `backend/app/ledger/router.py` (эндпоинты `categorize`, `dismiss-suggestion`)
- Test: `backend/tests/test_categorize_api.py`

- [ ] **Step 1: Падающий тест API-контракта**

Создать `backend/tests/test_categorize_api.py`:

```python
import uuid
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository, service

ALICE = {"email": "alice@example.com", "password": "password123"}


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


async def test_transaction_out_exposes_categorization_fields(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")
    txn = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-100.00"), occurred_at=date(2026, 7, 5), source="import",
    )
    txn.suggested_category_id = food_id
    txn.category_confidence = Decimal("0.400")
    await db_session.commit()

    resp = await client.get("/api/transactions", params={"workspace_id": str(ws)})
    item = resp.json()["items"][0]
    assert item["category_confirmed"] is False
    assert item["suggested_category_id"] == str(food_id)
    assert item["category_confidence"] == "0.400"


async def test_patch_category_confirms_and_clears_suggestion(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")
    txn = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-100.00"), occurred_at=date(2026, 7, 5), source="import",
    )
    txn.suggested_category_id = food_id
    await db_session.commit()

    resp = await client.patch(
        f"/api/transactions/{txn.id}",
        params={"workspace_id": str(ws)},
        json={"category_id": str(food_id)},
    )
    assert resp.status_code == 200
    await db_session.refresh(txn)
    assert txn.category_id == food_id
    assert txn.category_confirmed is True
    assert txn.suggested_category_id is None


async def test_dismiss_suggestion_clears_it(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(c.id for c in cats if c.name == "Еда")
    txn = await service.post_transaction(
        db_session, ws, user_id, account_id=acc, category_id=None,
        amount=Decimal("-100.00"), occurred_at=date(2026, 7, 5), source="import",
    )
    txn.suggested_category_id = food_id
    await db_session.commit()

    resp = await client.post(
        f"/api/transactions/{txn.id}/dismiss-suggestion",
        params={"workspace_id": str(ws)},
    )
    assert resp.status_code == 200
    await db_session.refresh(txn)
    assert txn.suggested_category_id is None
    assert txn.category_id is None
```

- [ ] **Step 2: Прогнать — должен падать**

Run: `uv run pytest tests/test_categorize_api.py -q`
Expected: FAIL — в ответе нет полей категоризации / нет эндпоинта dismiss.

- [ ] **Step 3: Расширить `TransactionOut`**

В `backend/app/ledger/schemas.py` добавить импорт сериализатора вверху:

```python
from pydantic import BaseModel, Field, field_serializer
```

и в класс `TransactionOut` добавить поля (после `transfer_group_id`) и сериализатор уверенности в строку (число из БД на провод — строкой, не float):

```python
    category_confirmed: bool
    suggested_category_id: uuid.UUID | None
    category_confidence: Decimal | None

    @field_serializer("category_confidence")
    def _serialize_confidence(self, value: Decimal | None) -> str | None:
        # квантуем до 3 знаков — стабильная ширина на проводе (как делает MoneyStr)
        return None if value is None else format(value.quantize(Decimal("0.001")), "f")
```

- [ ] **Step 4: `update_transaction` — подтверждение при простановке категории**

В `backend/app/ledger/service.py` в `update_transaction` после присваивания `transaction.category_id = new_category_id` добавить: явная простановка категории пользователем считается подтверждением и снимает подсказку. Заменить строку

```python
    transaction.category_id = new_category_id
```

на:

```python
    transaction.category_id = new_category_id
    if payload.category_id is not None:
        # пользователь явно выбрал категорию (подтвердил подсказку или переопределил)
        transaction.category_confirmed = True
        transaction.suggested_category_id = None
```

- [ ] **Step 5: `dismiss_suggestion` в сервисе**

В `backend/app/ledger/service.py` добавить функцию (рядом с `update_transaction`):

```python
async def dismiss_suggestion(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> Transaction:
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    transaction.suggested_category_id = None
    await db.commit()
    return transaction
```

- [ ] **Step 6: Эндпоинты `categorize` и `dismiss-suggestion`**

В `backend/app/ledger/router.py` добавить два эндпоинта (например, после `update_transaction`):

```python
@router.post("/transactions/categorize", status_code=202)
async def categorize_transactions(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
) -> dict[str, str]:
    service.enqueue_categorization(workspace_id)
    return {"status": "queued"}


@router.post("/transactions/{transaction_id}/dismiss-suggestion")
async def dismiss_suggestion(
    transaction_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TransactionOut:
    try:
        transaction = await service.dismiss_suggestion(db, workspace_id, transaction_id)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Операция не найдена") from None
    return _transaction_out(transaction)
```

**Порядок маршрутов:** `/transactions/categorize` объявлять до параметрических `/transactions/{transaction_id}`-маршрутов не обязательно (FastAPI матчит статический путь корректно), но если возникнет конфликт — поставить `categorize` выше в файле.

- [ ] **Step 7: Прогнать — должны проходить**

Run: `uv run pytest tests/test_categorize_api.py tests/test_categorize_trigger.py -q`
Expected: PASS (включая `test_categorize_endpoint_enqueues` из Task 6).

- [ ] **Step 8: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок. (`__import__(...)` в тестах допустим, но если ruff/mypy недовольны — заменить на обычные импорты `from decimal import Decimal` / `from datetime import date` вверху тест-файла.)

- [ ] **Step 9: Commit**

```bash
git add backend/app/ledger/schemas.py backend/app/ledger/service.py backend/app/ledger/router.py backend/tests/test_categorize_api.py
git commit -m "Ledger API: поля категоризации в ответе, подтверждение/сброс подсказки, эндпоинт categorize"
```

---

## Task 8: Границы модуля `ai` (import-linter)

**Files:**
- Modify: `backend/pyproject.toml` (контракты import-linter)

**Контекст:** два `ignore_imports` для ребра `app.ledger.tasks -> app.core.celery_app` (в контрактах «ledger не зависит от identity» и «identity и ledger не зависят от recurring») уже добавлены в рамках Task 6 — иначе тот коммит оставлял бы `lint-imports` красным. Здесь остаётся только добавить контракт независимости самого модуля `ai`.

- [ ] **Step 1: Добавить контракт независимости `ai`**

В `backend/pyproject.toml` после последнего контракта (`identity и ledger не зависят от imports`) добавить:

```toml
[[tool.importlinter.contracts]]
name = "ai не зависит от доменных модулей"
type = "forbidden"
source_modules = ["app.ai"]
forbidden_modules = [
    "app.identity", "app.ledger", "app.imports", "app.recurring",
]
```

`ledger → ai` при этом разрешён намеренно (обратное направление не запрещаем).

- [ ] **Step 2: Прогнать import-linter полностью (важно: без `| tail`, чтобы не проглотить код возврата)**

Run: `uv run lint-imports`
Expected: `Contracts: 7 kept, 0 broken`.

- [ ] **Step 3: Commit**

```bash
git add backend/pyproject.toml
git commit -m "import-linter: модуль ai доменно-независим"
```

---

## Task 9: Eval-набор и раннер точности

**Files:**
- Create: `backend/tests/data/categorize_eval.json`
- Create: `backend/tests/test_categorize_eval.py`
- Create: `backend/scripts/eval_categorize.py`

- [ ] **Step 1: Разметить eval-набор**

Создать `backend/tests/data/categorize_eval.json` (описания без PII, категории — из дефолтного набора workspace):

```json
[
  {"description": "Пятёрочка", "sign": "expense", "expected": "Еда"},
  {"description": "Магнит у дома", "sign": "expense", "expected": "Еда"},
  {"description": "Яндекс Такси", "sign": "expense", "expected": "Транспорт"},
  {"description": "Метрополитен проездной", "sign": "expense", "expected": "Транспорт"},
  {"description": "Аренда квартиры", "sign": "expense", "expected": "Жильё"},
  {"description": "МТС мобильная связь", "sign": "expense", "expected": "Связь"},
  {"description": "Кинотеатр КАРО", "sign": "expense", "expected": "Развлечения"},
  {"description": "Аптека Горздрав", "sign": "expense", "expected": "Здоровье"},
  {"description": "Зарплата за июль", "sign": "income", "expected": "Зарплата"},
  {"description": "Возврат за товар", "sign": "income", "expected": "Прочие доходы"}
]
```

- [ ] **Step 2: Детерминированный тест корректности набора (в CI)**

Создать `backend/tests/test_categorize_eval.py`:

```python
import json
from pathlib import Path

from app.ledger.repository import DEFAULT_CATEGORIES

EVAL_PATH = Path(__file__).parent / "data" / "categorize_eval.json"
_NAMES = {name for name, _ in DEFAULT_CATEGORIES}
_KIND_BY_NAME = {name: kind for name, kind in DEFAULT_CATEGORIES}


def test_eval_dataset_wellformed() -> None:
    data = json.loads(EVAL_PATH.read_text(encoding="utf-8"))
    assert len(data) >= 10
    for row in data:
        assert set(row) == {"description", "sign", "expected"}
        assert row["sign"] in {"expense", "income"}
        assert row["expected"] in _NAMES, f"неизвестная категория: {row['expected']}"
        # ожидаемая категория должна соответствовать знаку операции
        expected_kind = "expense" if row["sign"] == "expense" else "income"
        assert _KIND_BY_NAME[row["expected"]] == expected_kind
```

- [ ] **Step 3: Прогнать — должен проходить**

Run: `uv run pytest tests/test_categorize_eval.py -q`
Expected: PASS.

- [ ] **Step 4: Ручной раннер accuracy против живого провайдера**

Создать `backend/scripts/eval_categorize.py`:

```python
"""Ручной прогон accuracy автокатегоризации против живого LLM-провайдера.

Требует настроенных LLM_BASE_URL/LLM_API_KEY/LLM_MODEL_CATEGORIZE в окружении.
В CI не запускается (нужен ключ и сеть); это инструмент для калибровки порога
и модели на реальных описаниях.

Запуск: uv run python scripts/eval_categorize.py
"""

import asyncio
import json
import uuid
from decimal import Decimal
from pathlib import Path

from app.ai.client import build_llm_client
from app.ledger.categorization import classify_one
from app.ledger.models import Category
from app.ledger.repository import DEFAULT_CATEGORIES

EVAL_PATH = Path(__file__).parent.parent / "tests" / "data" / "categorize_eval.json"


def _candidates(kind: str) -> list[Category]:
    result: list[Category] = []
    for name, cat_kind in DEFAULT_CATEGORIES:
        if cat_kind == kind:
            cat = Category(name=name, kind=kind)
            cat.id = uuid.uuid4()
            result.append(cat)
    return result


async def main() -> None:
    data = json.loads(EVAL_PATH.read_text(encoding="utf-8"))
    llm = build_llm_client()
    correct = 0
    for row in data:
        candidates = _candidates(row["sign"])
        name, confidence = await classify_one(llm, row["description"], candidates, [])
        ok = name == row["expected"]
        correct += ok
        mark = "OK " if ok else "MISS"
        print(f"{mark} «{row['description']}» → {name} ({confidence}); ждали {row['expected']}")
    total = len(data)
    print(f"\nAccuracy: {correct}/{total} = {Decimal(correct) / Decimal(total):.2f}")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 5: Линт/типы**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy`
Expected: без ошибок. (`scripts/` входит в проверку, если попадает под `packages`; при необходимости убедиться, что типы функций проставлены — они проставлены выше.)

- [ ] **Step 6: Commit**

```bash
git add backend/tests/data/categorize_eval.json backend/tests/test_categorize_eval.py backend/scripts/eval_categorize.py
git commit -m "Eval: размеченный набор категоризации, проверка структуры в CI и ручной раннер accuracy"
```

---

## Task 10: Frontend — бейдж «AI», чип-подсказка, кнопка категоризации

**Files:**
- Modify: `frontend/src/api/ledger.ts`
- Create: `frontend/src/pages/CategoryCell.tsx`
- Create: `frontend/src/pages/CategoryCell.test.tsx`
- Modify: `frontend/src/pages/TransactionsPage.tsx`

Команды фронта — из `frontend/`.

- [ ] **Step 1: Расширить API-модуль**

В `frontend/src/api/ledger.ts` в интерфейс `Transaction` добавить поля:

```typescript
  category_confirmed: boolean
  suggested_category_id: string | null
  category_confidence: string | null
```

и в конце файла добавить функции:

```typescript
export const dismissSuggestion = (ws: string, id: string) =>
  api<Transaction>(`/api/transactions/${id}/dismiss-suggestion?${q(ws)}`, { method: 'POST' })

export const categorizeUncategorized = (ws: string) =>
  api<{ status: string }>(`/api/transactions/categorize?${q(ws)}`, { method: 'POST' })
```

- [ ] **Step 2: Падающий тест ячейки категории**

Создать `frontend/src/pages/CategoryCell.test.tsx`:

```tsx
import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CategoryCell } from './CategoryCell'
import type { Transaction } from '../api/ledger'

const base: Transaction = {
  id: 't1', account_id: 'a1', category_id: null, amount: '-100.00', currency: 'RUB',
  occurred_at: '2026-07-05', merchant: 'Пятёрочка', note: null, transfer_group_id: null,
  category_confirmed: false, suggested_category_id: null, category_confidence: null,
}

const wrap = (t: Transaction) =>
  render(
    <MantineProvider>
      <CategoryCell txn={t} categoryName={(id) => (id ? 'Еда' : null)}
        onConfirm={vi.fn()} onDismiss={vi.fn()} />
    </MantineProvider>,
  )

describe('CategoryCell', () => {
  it('показывает бейдж AI у авто-категории без подтверждения', () => {
    wrap({ ...base, category_id: 'c1', category_confirmed: false })
    expect(screen.getByText('Еда')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
  })

  it('показывает чип-подсказку с кнопками для suggested', () => {
    wrap({ ...base, suggested_category_id: 'c1' })
    expect(screen.getByText(/AI: Еда/)).toBeInTheDocument()
    expect(screen.getByLabelText('Подтвердить категорию')).toBeInTheDocument()
    expect(screen.getByLabelText('Отклонить подсказку')).toBeInTheDocument()
  })

  it('не показывает бейдж AI у подтверждённой категории', () => {
    wrap({ ...base, category_id: 'c1', category_confirmed: true })
    expect(screen.getByText('Еда')).toBeInTheDocument()
    expect(screen.queryByText('AI')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Прогнать — должен падать**

Run: `pnpm vitest run src/pages/CategoryCell.test.tsx`
Expected: FAIL — модуль `./CategoryCell` не найден.

- [ ] **Step 4: Реализовать `CategoryCell`**

Создать `frontend/src/pages/CategoryCell.tsx`:

```tsx
import { ActionIcon, Badge, Group, Text } from '@mantine/core'
import type { Transaction } from '../api/ledger'

interface Props {
  txn: Transaction
  categoryName: (id: string | null) => string | null
  onConfirm: (txn: Transaction) => void
  onDismiss: (txn: Transaction) => void
}

export function CategoryCell({ txn, categoryName, onConfirm, onDismiss }: Props) {
  if (txn.transfer_group_id) return <Text>Перевод</Text>

  // подсказка ниже порога — предложить подтвердить/отклонить
  if (txn.suggested_category_id && !txn.category_id) {
    const name = categoryName(txn.suggested_category_id) ?? '—'
    return (
      <Group gap="xs">
        <Text c="dimmed" size="sm">{`AI: ${name}`}</Text>
        <ActionIcon
          aria-label="Подтвердить категорию" size="sm" variant="light" color="green"
          onClick={() => onConfirm(txn)}
        >
          ✓
        </ActionIcon>
        <ActionIcon
          aria-label="Отклонить подсказку" size="sm" variant="subtle" color="gray"
          onClick={() => onDismiss(txn)}
        >
          ✗
        </ActionIcon>
      </Group>
    )
  }

  const name = categoryName(txn.category_id)
  if (!name) return <Text>—</Text>

  // авто-простановка AI ещё не подтверждена человеком — помечаем бейджем
  return (
    <Group gap="xs">
      <Text>{name}</Text>
      {txn.category_id && !txn.category_confirmed && (
        <Badge size="xs" variant="light" color="blue">AI</Badge>
      )}
    </Group>
  )
}
```

- [ ] **Step 5: Прогнать — должен проходить**

Run: `pnpm vitest run src/pages/CategoryCell.test.tsx`
Expected: PASS (3 passed).

- [ ] **Step 6: Подключить в `TransactionsPage`**

В `frontend/src/pages/TransactionsPage.tsx`:

1. В импорт из `../api/ledger` добавить `categorizeUncategorized, dismissSuggestion, updateTransaction` и тип `Transaction`:

```tsx
import {
  categorizeUncategorized, createTransaction, createTransfer, deleteTransaction,
  dismissSuggestion, getAccounts, getCategories, getTransactions, updateTransaction,
  type Transaction,
} from '../api/ledger'
import { CategoryCell } from './CategoryCell'
```

2. Добавить мутации (рядом с `deleteMut`):

```tsx
  const confirmMut = useMutation({
    mutationFn: (t: Transaction) =>
      updateTransaction(ws, t.id, { category_id: t.suggested_category_id! }),
    onSuccess: invalidate,
  })
  const dismissMut = useMutation({
    mutationFn: (t: Transaction) => dismissSuggestion(ws, t.id),
    onSuccess: invalidate,
  })
  const categorizeMut = useMutation({
    mutationFn: () => categorizeUncategorized(ws),
    onSuccess: invalidate,
  })
```

3. В шапке (`Group` с кнопками) добавить кнопку запуска категоризации:

```tsx
          <Button variant="light" loading={categorizeMut.isPending}
            onClick={() => categorizeMut.mutate()}>
            Категоризировать без категории
          </Button>
```

4. Заменить ячейку категории в таблице

```tsx
              <Table.Td>{t.transfer_group_id ? 'Перевод' : (categoryName(t.category_id) ?? '—')}</Table.Td>
```

на:

```tsx
              <Table.Td>
                <CategoryCell
                  txn={t}
                  categoryName={categoryName}
                  onConfirm={(x) => confirmMut.mutate(x)}
                  onDismiss={(x) => dismissMut.mutate(x)}
                />
              </Table.Td>
```

**Примечание:** после запуска категоризации задача выполняется в фоне (Celery); `invalidate` перезапросит ленту сразу, но результаты появятся после отработки воркера — пользователь увидит их при следующем обновлении/навигации. Это ожидаемо для v1 (без поллинга статуса).

- [ ] **Step 7: Прогнать фронт-тесты, линт, типы**

Run (из `frontend/`): `pnpm vitest run && pnpm lint && pnpm tsc --noEmit`
Expected: тесты зелёные; oxlint/tsc без ошибок. (Точные команды линта/типов — как в `frontend/package.json`; при расхождении использовать скрипты оттуда.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/ledger.ts frontend/src/pages/CategoryCell.tsx frontend/src/pages/CategoryCell.test.tsx frontend/src/pages/TransactionsPage.tsx
git commit -m "Фронт: бейдж AI, чип-подсказка категории и кнопка автокатегоризации"
```

---

## Финальная проверка этапа

- [ ] **Backend целиком:** из `backend/` — `uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`. Всё зелёное.
- [ ] **Frontend целиком:** из `frontend/` — `pnpm vitest run && pnpm lint && pnpm tsc --noEmit`. Всё зелёное.
- [ ] **Живой прогон (ручной):** поднять стек (`docker compose`), задать в `.env` реальные `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL_CATEGORIZE`, импортировать выписку, убедиться, что часть операций получила категорию (бейдж «AI»), часть — подсказку; подтвердить/отклонить; проверить лог воркера (только идентификаторы, без PII/сумм). При желании — `uv run python scripts/eval_categorize.py` для accuracy.
- [ ] **PR** после зелёного CI (по образцу прошлых этапов).



