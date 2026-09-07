# Категории по подсказке банка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Принимать категорию, которую банк уже определил, переводить её в наши слова и раскладывать операции без обращения к языковой модели.

**Architecture:** Перевод в два шага. Коннектор переводит слово банка (или MCC) в подсказку из нашего словаря на 37 значений — словарь банка дальше плагина не уезжает. Ядро разрешает подсказку в категорию этого workspace: находит категорию с такой отметкой или заводит подкатегорию под родителем по умолчанию. Подсказка применяется при подтверждении импорта, после правил «описание → категория» и до языковой модели.

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy 2 async / Alembic / pytest; TypeScript / Node / vitest.

**Спека:** `docs/superpowers/specs/2026-09-07-bank-category-hints-design.md`

---

## Структура файлов

**Бэкенд**

| файл | ответственность |
| --- | --- |
| `backend/app/core/category_hints.py` (создать) | словарь подсказок и раскладка по умолчанию — чистый модуль без БД |
| `backend/app/ledger/models.py` (править) | `Category.hint` |
| `backend/alembic/versions/0012_category_hint.py` (создать) | колонка и уникальность в пределах workspace |
| `backend/tests/test_migrations.py` (править) | схема после миграции: колонка nullable, индекс уникален |
| `backend/app/ledger/repository.py` (править) | `category_by_hint`, `category_by_name`, свёртка дашборда к родителю |
| `backend/app/ledger/service.py` (править) | `resolve_hint_category` — найти или завести подкатегорию |
| `backend/app/imports/schemas.py` (править) | приём `category_hint` на входе |
| `backend/app/imports/parser.py` (править) | `ParsedOperation.category_hint` |
| `backend/app/imports/service.py` (править) | провоз через payload и применение при подтверждении |
| `backend/tests/test_category_hints.py` (создать) | словарь, разрешение подсказки, применение при импорте |

**Коннектор**

| файл | ответственность |
| --- | --- |
| `collector/src/core/category-hints.ts` (создать) | словарь подсказок и таблица MCC — общие для всех банков |
| `collector/src/plugins/tbank/map.ts` (править) | таблица «метка Т-Банка → подсказка», `resolveHint` |
| `collector/src/plugins/tbank/types.ts` (править) | `category_hint` в операции |
| `collector/src/runner/main.ts` (править) | предупреждение о незнакомой метке |
| `collector/tests/fixtures/tbank-category-list.json` (есть) | справочник банка целиком — основа теста на полноту |
| `collector/src/plugins/tbank/hints.test.ts` (создать) | полнота покрытия справочника |

**Порядок:** сначала бэкенд (он валидирует договор), потом коннектор (он его соблюдает). Задачи 1–6 и 7–10 независимы между группами, внутри группы — последовательны.

---

### Task 1: Словарь подсказок и раскладка по умолчанию

**Files:**
- Create: `backend/app/core/category_hints.py`
- Test: `backend/tests/test_category_hints.py`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/tests/test_category_hints.py`:

```python
from app.core.category_hints import CATEGORY_HINTS, HINT_DEFAULTS, HintTarget
from app.ledger.repository import DEFAULT_CATEGORIES


def test_every_hint_has_a_target() -> None:
    """Раскладка неполна — подсказка молча перестанет срабатывать; лишняя
    запись — опечатка в имени подсказки."""
    assert set(HINT_DEFAULTS) == set(CATEGORY_HINTS)


def test_target_carries_parent_name_and_direction() -> None:
    assert HINT_DEFAULTS["groceries"] == HintTarget("Еда", "Продукты", "expense")


def test_salary_lands_in_parent_without_subcategory() -> None:
    """Дробить «Зарплату» не на что, и лишний уровень там был бы шумом."""
    assert HINT_DEFAULTS["salary"] == HintTarget("Зарплата", None, "income")


def test_parents_come_from_default_tree() -> None:
    """Родителя, которого нет в дефолтном наборе, подсказка не найдёт никогда."""
    known = {name for name, _ in DEFAULT_CATEGORIES}
    assert {t.parent for t in HINT_DEFAULTS.values()} - known == set()


def test_hint_direction_matches_parent_direction() -> None:
    """Доходная подсказка под расходным родителем не сработает ни разу:
    знак суммы не совпадёт."""
    kind_of = dict(DEFAULT_CATEGORIES)
    assert [h for h, t in HINT_DEFAULTS.items() if kind_of[t.parent] != t.kind] == []
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd backend && uv run pytest tests/test_category_hints.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.category_hints'`

- [ ] **Step 3: Написать модуль**

Создать `backend/app/core/category_hints.py`:

```python
from typing import Literal, NamedTuple, get_args

# Банконезависимый словарь подсказок о категории. Коннектор каждого банка
# переводит в него слова своего банка; бэкенд про «Супермаркеты» и MCC 5411
# не знает — по той же причине, по которой не знает про PAY и INTERNAL
# (см. app/core/operation_kinds.py).
#
# Словарь намеренно грубее банковских справочников: у Т-Банка их 90, и перевод
# один к одному завёл бы в дереве человека «Duty Free» и «Металлы в слитках».
CategoryHint = Literal[
    # еда
    "groceries",
    "dining",
    # транспорт
    "taxi",
    "transit",
    "fuel",
    "parking",
    "car",
    "car_rental",
    "travel",
    # жильё
    "utilities",
    "home",
    # связь
    "mobile",
    "internet",
    # развлечения
    "entertainment",
    "cinema",
    "music",
    "sports",
    # здоровье
    "pharmacy",
    "medical",
    "beauty",
    # прочее
    "clothing",
    "jewelry",
    "electronics",
    "marketplace",
    "pets",
    "kids",
    "gifts",
    "education",
    "charity",
    "taxes",
    "bank_fees",
    "services",
    "ecosystem",
    # доходы
    "salary",
    "benefits",
    "interest",
    "cashback",
]

# Тот же словарь значениями — для проверок на входе. Выводится из Literal,
# чтобы список не разъезжался с типом.
CATEGORY_HINTS: tuple[str, ...] = get_args(CategoryHint)


class HintTarget(NamedTuple):
    """Куда садится подсказка в дереве по умолчанию.

    `sub is None` — подсказка садится в самого родителя: дробить «Зарплату»
    не на что, и лишний уровень там был бы шумом.
    """

    parent: str
    sub: str | None
    kind: str


# Родители — категории из дефолтного набора (app/ledger/repository.py).
# Имена подкатегорий наши, а не банковские: см. §3 спеки.
HINT_DEFAULTS: dict[str, HintTarget] = {
    "groceries": HintTarget("Еда", "Продукты", "expense"),
    "dining": HintTarget("Еда", "Кафе и рестораны", "expense"),
    "taxi": HintTarget("Транспорт", "Такси", "expense"),
    "transit": HintTarget("Транспорт", "Общественный транспорт", "expense"),
    "fuel": HintTarget("Транспорт", "Заправки", "expense"),
    "parking": HintTarget("Транспорт", "Парковка и дороги", "expense"),
    "car": HintTarget("Транспорт", "Автомобиль", "expense"),
    "car_rental": HintTarget("Транспорт", "Аренда и каршеринг", "expense"),
    "travel": HintTarget("Транспорт", "Поездки", "expense"),
    "utilities": HintTarget("Жильё", "ЖКХ", "expense"),
    "home": HintTarget("Жильё", "Ремонт и обустройство", "expense"),
    "mobile": HintTarget("Связь", "Мобильная связь", "expense"),
    "internet": HintTarget("Связь", "Интернет и ТВ", "expense"),
    "entertainment": HintTarget("Развлечения", "Досуг", "expense"),
    "cinema": HintTarget("Развлечения", "Кино", "expense"),
    "music": HintTarget("Развлечения", "Музыка и подписки", "expense"),
    "sports": HintTarget("Развлечения", "Спорт", "expense"),
    "pharmacy": HintTarget("Здоровье", "Аптеки", "expense"),
    "medical": HintTarget("Здоровье", "Медицина", "expense"),
    "beauty": HintTarget("Здоровье", "Красота", "expense"),
    "clothing": HintTarget("Прочее", "Одежда и обувь", "expense"),
    "jewelry": HintTarget("Прочее", "Украшения", "expense"),
    "electronics": HintTarget("Прочее", "Техника", "expense"),
    "marketplace": HintTarget("Прочее", "Маркетплейсы", "expense"),
    "pets": HintTarget("Прочее", "Животные", "expense"),
    "kids": HintTarget("Прочее", "Детское", "expense"),
    "gifts": HintTarget("Прочее", "Подарки и цветы", "expense"),
    "education": HintTarget("Прочее", "Образование", "expense"),
    "charity": HintTarget("Прочее", "Благотворительность", "expense"),
    "taxes": HintTarget("Прочее", "Налоги и штрафы", "expense"),
    "bank_fees": HintTarget("Прочее", "Услуги банка", "expense"),
    "services": HintTarget("Прочее", "Услуги", "expense"),
    "ecosystem": HintTarget("Прочее", "Экосистемы", "expense"),
    "salary": HintTarget("Зарплата", None, "income"),
    "benefits": HintTarget("Прочие доходы", "Пособия и пенсии", "income"),
    "interest": HintTarget("Прочие доходы", "Проценты и дивиденды", "income"),
    "cashback": HintTarget("Прочие доходы", "Бонусы", "income"),
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `cd backend && uv run pytest tests/test_category_hints.py -v`
Expected: PASS, 5 тестов

- [ ] **Step 5: Линт и типы**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy .`
Expected: без замечаний

- [ ] **Step 6: Коммит**

```bash
git add backend/app/core/category_hints.py backend/tests/test_category_hints.py
git commit -m "Словарь подсказок о категории и раскладка по умолчанию"
```

---

### Task 2: Отметка подсказки на категории

**Files:**
- Modify: `backend/app/ledger/models.py:45-53`
- Create: `backend/alembic/versions/0012_category_hint.py`

- [ ] **Step 1: Добавить колонку в модель**

В `backend/app/ledger/models.py`, в классе `Category`, после `kind`:

```python
    # «сюда садится вот эта подсказка банка». Отметка на самой категории, а не
    # отдельная таблица соответствий: переименование категории соответствие не
    # рвёт, а переназначить подсказку — значит отредактировать категорию
    hint: Mapped[str | None] = mapped_column(String(30), nullable=True)
```

- [ ] **Step 2: Написать миграцию**

Создать `backend/alembic/versions/0012_category_hint.py`:

```python
"""Отметка подсказки банка на категории"""

import sqlalchemy as sa

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("categories", sa.Column("hint", sa.String(30), nullable=True))
    # одна подсказка — одна категория внутри workspace: иначе разрешение
    # подсказки перестало бы быть однозначным. NULL уникальности не мешает,
    # так что категорий без отметки может быть сколько угодно
    op.create_index(
        "ix_categories_workspace_hint",
        "categories",
        ["workspace_id", "hint"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_categories_workspace_hint", table_name="categories")
    op.drop_column("categories", "hint")
```

- [ ] **Step 3: Закрепить схему тестом**

Порт Postgres наружу не проброшен, а миграции накатывает контейнер бэкенда при старте, так что локальный `alembic upgrade` до базы не достучится. Проверяются миграции иначе: `backend/tests/test_migrations.py` смотрит получившуюся схему через `information_schema` на базе от testcontainers, которая поднимается фикстурой `database_url` и прогоняет `alembic upgrade head` сама. Дописать туда, следуя стилю соседних тестов:

```python
async def test_migrations_add_category_hint(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name = 'categories' AND column_name = 'hint'"
            )
        )
        nullable = rows.scalar()
        indexes = await conn.execute(
            text("SELECT indexdef FROM pg_indexes WHERE indexname = :name"),
            {"name": "ix_categories_workspace_hint"},
        )
        indexdef = indexes.scalar()
    await engine.dispose()
    # отметка обязана быть nullable: категорий без подсказки — большинство
    assert nullable == "YES"
    # уникальность именно по паре: одна подсказка — одна категория внутри
    # workspace, иначе разрешение подсказки перестаёт быть однозначным
    assert indexdef is not None
    assert "UNIQUE" in indexdef
    assert "workspace_id" in indexdef and "hint" in indexdef
```

- [ ] **Step 4: Проверить обратимость на одноразовой базе**

Базу владельца не трогаем — поднимаем свою и сносим после:

```bash
docker run --rm -d --name mr-mig -p 55432:5432 \
  -e POSTGRES_USER=aiccountant -e POSTGRES_PASSWORD=x -e POSTGRES_DB=aiccountant postgres:16
```

Дождаться готовности (`docker exec mr-mig pg_isready -U aiccountant`), затем из `backend/`:

```bash
DATABASE_URL=postgresql+asyncpg://aiccountant:x@localhost:55432/aiccountant uv run alembic upgrade head
DATABASE_URL=postgresql+asyncpg://aiccountant:x@localhost:55432/aiccountant uv run alembic downgrade -1
DATABASE_URL=postgresql+asyncpg://aiccountant:x@localhost:55432/aiccountant uv run alembic upgrade head
```

Expected: три команды без ошибок; в выводе первой — `Running upgrade 0011 -> 0012`. После — `docker rm -f mr-mig`.

`alembic` берёт адрес из настроек (`backend/alembic/env.py:22`), а те читают `DATABASE_URL` из окружения.

- [ ] **Step 5: Линт и типы**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy .`
Expected: без замечаний

- [ ] **Step 6: Коммит**

```bash
git add backend/app/ledger/models.py backend/alembic/versions/0012_category_hint.py backend/tests/test_migrations.py
git commit -m "Колонка hint у категории и уникальность в пределах workspace"
```

---

### Task 3: Разрешение подсказки в категорию

**Files:**
- Modify: `backend/app/ledger/repository.py` (рядом с `list_categories`)
- Modify: `backend/app/ledger/service.py` (рядом с `category_for_description`)
- Test: `backend/tests/test_category_hints.py`

- [ ] **Step 1: Написать падающий тест**

Дописать в `backend/tests/test_category_hints.py`:

Фикстуры в проекте — `client` и `db_session` (`backend/tests/conftest.py`); workspace создаётся регистрацией через API, `asyncio_mode = "auto"`, поэтому декораторы не нужны. Имена тестов английские, объяснения русские — как в `backend/tests/test_description_rules.py`.

```python
import uuid
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import service as ledger_service
from app.ledger.models import Category

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _register(client: AsyncClient, credentials: dict[str, str]) -> tuple[str, str]:
    """Зарегистрировать пользователя и вернуть его workspace со счётом."""
    await client.post("/api/auth/register", json=credentials)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def _resolve(db: AsyncSession, ws: str, hint: str, amount: str) -> uuid.UUID | None:
    # сумма строкой: деньги в этом проекте не проходят через float нигде,
    # включая тесты
    return await ledger_service.resolve_hint_category(db, uuid.UUID(ws), hint, Decimal(amount))


async def test_hint_creates_subcategory_under_right_parent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "groceries", "-100.00")
    assert category_id is not None
    created = await db_session.get(Category, category_id)
    assert created is not None
    assert created.name == "Продукты"
    assert created.hint == "groceries"
    parent = await db_session.get(Category, created.parent_id)
    assert parent is not None
    assert parent.name == "Еда"


async def test_second_operation_reuses_the_same_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Дерево пополняется один раз, а не на каждую операцию."""
    ws, _ = await _register(client, ALICE)
    first = await _resolve(db_session, ws, "groceries", "-100.00")
    second = await _resolve(db_session, ws, "groceries", "-200.00")
    assert first == second


async def test_renaming_category_keeps_it_as_target(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Отметка живёт на категории, а не в имени: переименование соответствие
    не рвёт — ради этого она и на категории."""
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "groceries", "-100.00")
    created = await db_session.get(Category, category_id)
    assert created is not None
    created.name = "Еда домой"
    await db_session.flush()

    assert await _resolve(db_session, ws, "groceries", "-100.00") == category_id


async def test_income_hint_on_expense_does_not_fire(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подсказка «зарплата» на расходе — признак того, что операцию поняли
    неверно, а не повод положить расход в доходы."""
    ws, _ = await _register(client, ALICE)
    assert await _resolve(db_session, ws, "salary", "-100.00") is None


async def test_salary_marks_parent_instead_of_creating_child(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "salary", "5000.00")
    created = await db_session.get(Category, category_id)
    assert created is not None
    assert created.name == "Зарплата"
    assert created.parent_id is None


async def test_deleted_parent_is_not_resurrected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    parent = await ledger_service.find_category_by_name(db_session, uuid.UUID(ws), "Еда")
    assert parent is not None
    await db_session.delete(parent)
    await db_session.flush()

    assert await _resolve(db_session, ws, "groceries", "-100.00") is None


async def test_hint_outside_vocabulary_does_not_fire(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Разошлись версии коннектора и приложения — операция остаётся без
    категории, а не получает случайную."""
    ws, _ = await _register(client, ALICE)
    assert await _resolve(db_session, ws, "самолёты", "-100.00") is None


async def test_hint_of_another_workspace_is_invisible(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws_alice, _ = await _register(client, ALICE)
    mine = await _resolve(db_session, ws_alice, "groceries", "-100.00")
    ws_bob, _ = await _register(client, BOB)
    theirs = await _resolve(db_session, ws_bob, "groceries", "-100.00")
    assert mine is not None
    assert theirs is not None
    assert mine != theirs
```

Переключение на второго пользователя работает так же, как в `backend/tests/test_learned_rules.py:230`: у `client` держится сессия, и регистрация второго её меняет. Возвращаться к первому — через `POST /api/auth/login`.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd backend && uv run pytest tests/test_category_hints.py -v`
Expected: FAIL — `AttributeError: module 'app.ledger.service' has no attribute 'resolve_hint_category'`

- [ ] **Step 3: Добавить запросы в repository**

В `backend/app/ledger/repository.py` после `get_category`:

```python
async def category_by_hint(
    db: AsyncSession, workspace_id: uuid.UUID, hint: str
) -> Category | None:
    category: Category | None = await db.scalar(
        select(Category).where(Category.workspace_id == workspace_id, Category.hint == hint)
    )
    return category


async def category_by_name(
    db: AsyncSession, workspace_id: uuid.UUID, name: str, parent_id: uuid.UUID | None
) -> Category | None:
    category: Category | None = await db.scalar(
        select(Category).where(
            Category.workspace_id == workspace_id,
            Category.name == name,
            Category.parent_id == parent_id,
        )
    )
    return category
```

- [ ] **Step 4: Добавить разрешение в service**

В `backend/app/ledger/service.py` после `category_for_description`:

```python
async def find_category_by_name(
    db: AsyncSession, workspace_id: uuid.UUID, name: str
) -> Category | None:
    """Категория верхнего уровня по имени — родитель для подсказки."""
    return await repository.category_by_name(db, workspace_id, name, None)


async def resolve_hint_category(
    db: AsyncSession, workspace_id: uuid.UUID, hint: str, amount: Decimal
) -> uuid.UUID | None:
    """Категория, в которую садится подсказка банка; None — подсказка не сработала.

    Заводит подкатегорию при первой же операции с такой подсказкой: дерево
    пополняется только тем, на что человек действительно тратит.

    Не срабатывает молча в трёх случаях, и все три — не ошибка:
    подсказки нет в словаре (разошлись версии коннектора и приложения),
    знак суммы не совпал с направлением категории, родителя удалили.
    """
    target = HINT_DEFAULTS.get(hint)
    if target is None or not category_matches_amount(target.kind, amount):
        return None

    existing = await repository.category_by_hint(db, workspace_id, hint)
    if existing is not None:
        return existing.id

    parent = await repository.category_by_name(db, workspace_id, target.parent, None)
    if parent is None:
        # человек удалил родителя — воскрешать его подсказкой не наше дело
        return None
    if target.sub is None:
        # подсказка садится в самого родителя: помечаем его и не плодим уровень
        parent.hint = hint
        await db.flush()
        return parent.id

    # имя могло быть занято своей категорией человека — тогда берём её и
    # помечаем, а не заводим вторую с тем же именем под тем же родителем
    child = await repository.category_by_name(db, workspace_id, target.sub, parent.id)
    if child is None:
        child = Category(
            workspace_id=workspace_id,
            parent_id=parent.id,
            name=target.sub,
            kind=target.kind,
        )
        repository.add_category(db, child)
    child.hint = hint
    await db.flush()
    return child.id
```

Импорты в начало `service.py`: `from app.core.category_hints import HINT_DEFAULTS`.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd backend && uv run pytest tests/test_category_hints.py -v`
Expected: PASS, 13 тестов

- [ ] **Step 6: Линт, типы, границы модулей**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports`
Expected: без замечаний

- [ ] **Step 7: Коммит**

```bash
git add backend/app/ledger/repository.py backend/app/ledger/service.py backend/tests/test_category_hints.py
git commit -m "Разрешение подсказки банка в категорию workspace"
```

---

### Task 4: Приём подсказки на входе импорта

**Files:**
- Modify: `backend/app/imports/schemas.py:80-90` (класс `ParsedOperationIn`)
- Modify: `backend/app/imports/parser.py:23-29` (`ParsedOperation`)
- Modify: `backend/app/imports/service.py:75-91` (`_statement_to_payload`), `:165-195` (`_payload_to_statement`), `:237-260` (`create_parsed_import`)
- Test: `backend/tests/test_category_hints.py`

- [ ] **Step 1: Написать падающий тест**

Дописать в `backend/tests/test_category_hints.py`:

```python
import pytest
from pydantic import ValidationError

from app.imports.schemas import ParsedOperationIn

OPERATION = {
    "occurred_at": "2026-09-01",
    "amount": "-100.00",
    "currency": "RUB",
    "description": "Пятёрочка",
    "external_id": "bank-1",
}


def test_schema_accepts_hint_from_vocabulary() -> None:
    op = ParsedOperationIn(**OPERATION, category_hint="groceries")
    assert op.category_hint == "groceries"


def test_schema_rejects_hint_outside_vocabulary() -> None:
    """Слово вне словаря — баг коллектора или разъехавшиеся версии; лучше 422,
    чем категория, которой ни одна операция не соответствует."""
    with pytest.raises(ValidationError):
        ParsedOperationIn(**OPERATION, category_hint="самолёты")


def test_hint_is_optional() -> None:
    """Разбор PDF-выписки о категории ничего не знает."""
    assert ParsedOperationIn(**OPERATION).category_hint is None
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd backend && uv run pytest tests/test_category_hints.py -k schema -v`
Expected: FAIL — `ParsedOperationIn` не знает поля `category_hint`. Pydantic по умолчанию лишние поля игнорирует, так что `test_schema_accepts_hint_from_vocabulary` падает на `AttributeError`, а `test_schema_rejects_hint_outside_vocabulary` — на том, что `ValidationError` не поднялась

- [ ] **Step 3: Добавить поле в схему**

В `backend/app/imports/schemas.py`, в классе `ParsedOperationIn`, после поля `kind`:

```python
    # подсказка банка о категории в нашем словаре; слова банка переводит
    # коннектор. None — источник о категории ничего не сообщил (PDF-выписка)
    category_hint: CategoryHint | None = None
```

Импорт в начало файла: `from app.core.category_hints import CategoryHint`.

- [ ] **Step 4: Провезти подсказку через разбор**

В `backend/app/imports/parser.py`, в `ParsedOperation`, после `kind`:

```python
    # None — источник о категории не сообщил; тип str, а не CategoryHint, по той
    # же причине, что и у kind: словарём значение становится на входе в ledger
    category_hint: str | None = None
```

В `backend/app/imports/service.py`, в `_statement_to_payload`, в словарь операции после `"kind": op.kind,`:

```python
                "category_hint": op.category_hint,
```

В `_payload_to_statement`, в конструктор `ParsedOperation` после `kind=...`:

```python
                # у импортов, созданных до появления подсказки, ключа нет —
                # это не порча, а прежняя версия payload
                category_hint=_optional_str(op.get("category_hint")),
```

Там же в `service.py`, рядом с `_finite_decimal`:

```python
def _optional_str(value: object) -> str | None:
    """Строка из JSONB или None. Отдельная функция, потому что str(None) даёт
    "None" — строку, которая ни одной подсказке не соответствует, но выглядит
    как значение."""
    return None if value is None else str(value)
```

В `create_parsed_import`, в конструктор `ParsedOperation` после `kind=op.kind,`:

```python
                category_hint=op.category_hint,
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd backend && uv run pytest tests/test_category_hints.py -v`
Expected: PASS, 16 тестов

- [ ] **Step 6: Убедиться, что прежние импорты не сломались**

Run: `cd backend && uv run pytest tests/test_imports_api.py tests/test_imports_parsed.py tests/test_description_rules.py -v`
Expected: PASS — payload без ключа `category_hint` по-прежнему читается

- [ ] **Step 7: Линт, типы, границы модулей**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports`
Expected: без замечаний

- [ ] **Step 8: Коммит**

```bash
git add backend/app/imports/schemas.py backend/app/imports/parser.py backend/app/imports/service.py backend/tests/test_category_hints.py
git commit -m "Подсказка банка о категории доезжает от коллектора до подтверждения импорта"
```

---

### Task 5: Подсказка применяется при подтверждении импорта

**Files:**
- Modify: `backend/app/imports/service.py:485-511` (цикл в `confirm_import`)
- Test: `backend/tests/test_category_hints.py`

- [ ] **Step 1: Написать падающий тест**

Дописать в `backend/tests/test_category_hints.py`. Путь «создать разобранный импорт → подтвердить» повторяет `backend/tests/test_description_rules.py`: `POST /api/imports/parsed`, затем `POST /api/imports/{id}/commit`.

```python
from typing import Any

OP = {
    "occurred_at": "2026-09-01",
    "amount": "-450.00",
    "currency": "RUB",
    "kind": "purchase",
}


async def _import(client: AsyncClient, ws: str, acc: str, *operations: dict[str, Any]) -> int:
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "test_collector", "operations": list(operations)},
    )
    assert started.status_code == 201
    committed = await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.status_code == 200
    imported: int = committed.json()["imported"]
    return imported


async def _transactions(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/transactions", params={"workspace_id": ws})
    assert resp.status_code == 200
    items: list[dict[str, Any]] = resp.json()["items"]
    return items


async def _category_names(client: AsyncClient, ws: str) -> list[str]:
    resp = await client.get("/api/categories", params={"workspace_id": ws})
    assert resp.status_code == 200
    return [str(c["name"]) for c in resp.json()]


async def _category_name(client: AsyncClient, ws: str, category_id: str) -> str:
    resp = await client.get("/api/categories", params={"workspace_id": ws})
    return str(next(c for c in resp.json() if str(c["id"]) == category_id)["name"])


async def test_hint_puts_operation_into_subcategory(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import(
        client, ws, acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
    )

    item = (await _transactions(client, ws))[0]
    assert await _category_name(client, ws, item["category_id"]) == "Продукты"
    # решение машинное: эту конкретную операцию человек не смотрел
    assert item["category_confirmed"] is False
    # подсказка детерминирована; приписать ей уверенность значило бы выдать
    # таблицу за оценку модели
    assert item["category_confidence"] is None


async def test_human_rule_beats_bank_hint(client: AsyncClient, db_session: AsyncSession) -> None:
    """Порядок конвейера: решение человека сильнее подсказки банка."""
    ws, acc = await _register(client, ALICE)
    own = (
        await client.post(
            "/api/categories",
            params={"workspace_id": ws},
            json={"name": "Моя еда", "kind": "expense"},
        )
    ).json()["id"]
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Пятёрочка", uuid.UUID(own)
    )

    await _import(
        client, ws, acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
    )

    assert (await _transactions(client, ws))[0]["category_id"] == own


async def test_operation_without_hint_stays_uncategorized(client: AsyncClient) -> None:
    """Банк не подсказал — операция ждёт модель, как ждала до этой работы."""
    ws, acc = await _register(client, ALICE)
    await _import(client, ws, acc, {**OP, "description": "Что-то", "external_id": "op-1"})

    assert (await _transactions(client, ws))[0]["category_id"] is None


async def test_hint_does_not_create_a_learned_rule(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Правило — след решения человека. Заводись оно от подсказки, машинная
    догадка стала бы неотличима от подтверждения и пережила бы её отмену."""
    ws, acc = await _register(client, ALICE)
    await _import(
        client, ws, acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
    )

    assert await ledger_service.load_description_rules(db_session, uuid.UUID(ws)) == {}


async def test_subcategory_is_created_once_per_batch(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    imported = await _import(
        client, ws, acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
        {**OP, "description": "Магнит", "external_id": "op-2", "category_hint": "groceries"},
    )
    assert imported == 2

    ids = {item["category_id"] for item in await _transactions(client, ws)}
    assert len(ids) == 1
    # ровно одна «Продукты», а не по одной на операцию
    assert (await _category_names(client, ws)).count("Продукты") == 1
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && uv run pytest tests/test_category_hints.py -v`
Expected: пять новых тестов FAIL — категория у операции `None`, подсказка при подтверждении не применяется. Прежние 16 по-прежнему PASS

- [ ] **Step 3: Применить подсказку в цикле подтверждения**

В `backend/app/imports/service.py`, в `confirm_import`, заменить блок вычисления категории. Было:

```python
        rule_category_id = ledger_service.category_for_description(rules, op.description, op.amount)
        await ledger_service.post_transaction(
            db,
            workspace_id,
            user_id,
            account_id=imp.account_id,
            category_id=rule_category_id,
```

Стало:

```python
        # порядок конвейера: решение человека сильнее подсказки банка, подсказка
        # банка сильнее догадки модели (она отработает позже, уже по остаткам).
        # Ни правило, ни подсказка не ставят category_confirmed: эту конкретную
        # операцию человек не смотрел
        category_id = ledger_service.category_for_description(rules, op.description, op.amount)
        if category_id is None and op.category_hint is not None:
            category_id = await ledger_service.resolve_hint_category(
                db, workspace_id, op.category_hint, op.amount
            )
        await ledger_service.post_transaction(
            db,
            workspace_id,
            user_id,
            account_id=imp.account_id,
            category_id=category_id,
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd backend && uv run pytest tests/test_category_hints.py -v`
Expected: PASS, 21 тест

- [ ] **Step 5: Прогнать бэкенд целиком**

Run: `cd backend && uv run pytest -q`
Expected: PASS

- [ ] **Step 6: Линт, типы, границы модулей**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports`
Expected: без замечаний

- [ ] **Step 7: Коммит**

```bash
git add backend/app/imports/service.py backend/tests/test_category_hints.py
git commit -m "Подсказка банка раскладывает операции при подтверждении импорта"
```

---

### Task 6: Дашборд сворачивается к верхнему уровню

**Files:**
- Modify: `backend/app/ledger/repository.py:253-270` (`month_expenses_by_category`)
- Test: `backend/tests/test_category_hints.py`

- [ ] **Step 1: Написать падающий тест**

Дописать в `backend/tests/test_category_hints.py`:

Проверяем через `/api/dashboard`, как это делает `backend/tests/test_dashboard_api.py`: считает свёртку запрос в repository, но видит её человек именно на дашборде, и границы месяца тогда не приходится вычислять в тесте заново.

```python
from datetime import date


async def _month_expenses(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/dashboard", params={"workspace_id": ws})
    assert resp.status_code == 200
    rows: list[dict[str, Any]] = resp.json()["month_expenses"]
    return rows


async def _spend(client: AsyncClient, ws: str, acc: str, category_id: str, amount: str) -> None:
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={
            "account_id": acc,
            "category_id": category_id,
            "amount": amount,
            "occurred_at": date.today().isoformat(),
        },
    )
    assert resp.status_code == 201


async def test_subcategory_spending_counts_in_parent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Без свёртки первый же сбор с подсказками опустошил бы «Еду», разложив
    её по «Продуктам» и «Кафе»."""
    ws, acc = await _register(client, ALICE)
    # commit не нужен: у теста и у приложения сессия одна, flush внутри
    # resolve_hint_category делает категории видимыми для следующего запроса
    groceries = await _resolve(db_session, ws, "groceries", "-1.00")
    dining = await _resolve(db_session, ws, "dining", "-1.00")
    await _spend(client, ws, acc, str(groceries), "-100.00")
    await _spend(client, ws, acc, str(dining), "-50.00")

    rows = await _month_expenses(client, ws)
    assert [(r["category_name"], r["total"]) for r in rows] == [("Еда", "150.0000")]


async def test_top_level_category_counts_on_its_own(client: AsyncClient) -> None:
    """У категории верхнего уровня родителя нет, и считаться она должна сама
    по себе, а не пропасть из свёртки."""
    ws, acc = await _register(client, ALICE)
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c for c in cats if c["name"] == "Еда")
    await _spend(client, ws, acc, food["id"], "-70.00")

    rows = await _month_expenses(client, ws)
    assert [(r["category_id"], r["category_name"]) for r in rows] == [(food["id"], "Еда")]
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && uv run pytest tests/test_category_hints.py -k subcategory_spending -v`
Expected: FAIL — две строки, «Продукты» и «Кафе и рестораны», вместо одной «Еда»

- [ ] **Step 3: Свернуть группировку к родителю**

В `backend/app/ledger/repository.py` заменить `month_expenses_by_category`:

```python
async def month_expenses_by_category(
    db: AsyncSession, workspace_id: uuid.UUID, month_start: date, next_month_start: date
) -> list[tuple[uuid.UUID | None, str | None, Decimal]]:
    """Расходы месяца по категориям верхнего уровня.

    Подкатегории сворачиваются в родителя: итоги на дашборде считаются по
    верхнему уровню — он стабилен и задан человеком, — а детализация, которую
    приносит банк, видна в ленте операций. Без свёртки первый же сбор с
    подсказками опустошил бы «Еду», разложив её по «Продуктам» и «Кафе».
    """
    total = func.sum(-Transaction.amount)
    # COALESCE, а не JOIN на родителя: у категории верхнего уровня parent_id
    # пуст, и она должна считаться сама по себе
    top_id = func.coalesce(Category.parent_id, Category.id)
    parent = aliased(Category)
    top_name = func.coalesce(parent.name, Category.name)
    rows = await db.execute(
        select(top_id, top_name, total)
        .outerjoin(Category, Category.id == Transaction.category_id)
        .outerjoin(parent, parent.id == Category.parent_id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.amount < 0,
            counts_in_stats_sql(),
            Transaction.occurred_at >= month_start,
            Transaction.occurred_at < next_month_start,
        )
        .group_by(top_id, top_name)
        .order_by(total.desc())
    )
    return [(cid, name, Decimal(t)) for cid, name, t in rows.all()]
```

Импорт в начало файла: `from sqlalchemy.orm import aliased`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd backend && uv run pytest tests/test_category_hints.py tests/test_dashboard_api.py -v`
Expected: PASS, 23 теста в файле подсказок — и прежние тесты дашборда целы: операции без категории и категории верхнего уровня считаются как раньше

- [ ] **Step 5: Прогнать бэкенд целиком**

Run: `cd backend && uv run pytest -q`
Expected: PASS

- [ ] **Step 6: Линт, типы, границы модулей**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports`
Expected: без замечаний

- [ ] **Step 7: Коммит**

```bash
git add backend/app/ledger/repository.py backend/tests/test_category_hints.py
git commit -m "Расходы месяца сворачиваются к категориям верхнего уровня"
```

---

### Task 7: Словарь подсказок и таблица MCC в коннекторе

**Files:**
- Create: `collector/src/core/category-hints.ts`
- Test: `collector/src/core/category-hints.test.ts`

MCC — международный стандарт, и `5411` у любого банка значит одно и то же. Поэтому таблица живёт вне плагина Т-Банка: следующий коннектор возьмёт её как есть.

- [ ] **Step 1: Написать падающий тест**

Создать `collector/src/core/category-hints.test.ts`:

```ts
import { expect, test } from 'vitest'
import { CATEGORY_HINTS, hintFromMcc } from './category-hints'

test('код супермаркета переводится в подсказку', () => {
  expect(hintFromMcc('5411')).toBe('groceries')
})

test('код из диапазона авиалиний переводится в поездки', () => {
  // у каждой авиакомпании свой код в 3000–3299, перечислять их незачем
  expect(hintFromMcc('3012')).toBe('travel')
  expect(hintFromMcc('3721')).toBe('travel')
})

test('заглушки банка кодами не считаются', () => {
  // ровно эти значения приходят от Т-Банка вместо MCC у переводов
  for (const stub of ['0 0000', '1 0001', '9999 9999', '8 0008', '18 0018']) {
    expect(hintFromMcc(stub)).toBeNull()
  }
})

test('отсутствие кода и незнакомый код дают пусто', () => {
  expect(hintFromMcc(undefined)).toBeNull()
  expect(hintFromMcc('7777')).toBeNull()
})

test('снятие наличных подсказкой не считается', () => {
  // 6011 — банкомат: это вид операции, а не то, на что потрачены деньги
  expect(hintFromMcc('6011')).toBeNull()
})

test('все значения таблицы есть в словаре', () => {
  const known = new Set<string>(CATEGORY_HINTS)
  const codes = ['5411', '5812', '4121', '4900', '5912', '8011', '5944', '0742']
  for (const code of codes) {
    const hint = hintFromMcc(code)
    expect(hint === null || known.has(hint)).toBe(true)
  }
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd collector && pnpm vitest run src/core/category-hints.test.ts`
Expected: FAIL — `Cannot find module './category-hints'`

- [ ] **Step 3: Написать модуль**

Создать `collector/src/core/category-hints.ts`:

```ts
/**
 * Банконезависимый словарь подсказок о категории и перевод MCC в него.
 *
 * Словарь повторяет `backend/app/core/category_hints.py` — это договор между
 * коннектором и приложением, и расходиться им нельзя: приложение отвечает 422
 * на значение, которого не знает. Ровно так же продублирован словарь видов
 * операций.
 *
 * MCC — международный стандарт, поэтому таблица лежит здесь, а не в плагине
 * конкретного банка: 5411 у Сбера значит то же, что у Т-Банка.
 */
export type CategoryHint =
  | 'groceries'
  | 'dining'
  | 'taxi'
  | 'transit'
  | 'fuel'
  | 'parking'
  | 'car'
  | 'car_rental'
  | 'travel'
  | 'utilities'
  | 'home'
  | 'mobile'
  | 'internet'
  | 'entertainment'
  | 'cinema'
  | 'music'
  | 'sports'
  | 'pharmacy'
  | 'medical'
  | 'beauty'
  | 'clothing'
  | 'jewelry'
  | 'electronics'
  | 'marketplace'
  | 'pets'
  | 'kids'
  | 'gifts'
  | 'education'
  | 'charity'
  | 'taxes'
  | 'bank_fees'
  | 'services'
  | 'ecosystem'
  | 'salary'
  | 'benefits'
  | 'interest'
  | 'cashback'

export const CATEGORY_HINTS: readonly CategoryHint[] = [
  'groceries', 'dining', 'taxi', 'transit', 'fuel', 'parking', 'car', 'car_rental', 'travel',
  'utilities', 'home', 'mobile', 'internet', 'entertainment', 'cinema', 'music', 'sports',
  'pharmacy', 'medical', 'beauty', 'clothing', 'jewelry', 'electronics', 'marketplace', 'pets',
  'kids', 'gifts', 'education', 'charity', 'taxes', 'bank_fees', 'services', 'ecosystem',
  'salary', 'benefits', 'interest', 'cashback',
]

// Коды, которые встречаются в быту. Полный список MCC — около тысячи значений,
// и переписывать его целиком незачем: незнакомый код просто не даёт подсказки.
const MCC_TO_HINT: Record<string, CategoryHint> = {
  // еда
  '5411': 'groceries', '5412': 'groceries', '5422': 'groceries', '5441': 'groceries',
  '5451': 'groceries', '5462': 'groceries', '5499': 'groceries',
  '5811': 'dining', '5812': 'dining', '5813': 'dining', '5814': 'dining',
  // транспорт
  '4121': 'taxi',
  '4111': 'transit', '4112': 'transit', '4131': 'transit', '4789': 'transit',
  '5541': 'fuel', '5542': 'fuel', '5983': 'fuel',
  '7523': 'parking', '4784': 'parking',
  '5511': 'car', '5531': 'car', '5532': 'car', '5533': 'car', '5571': 'car',
  '7531': 'car', '7534': 'car', '7535': 'car', '7538': 'car', '7542': 'car', '7549': 'car',
  '7512': 'car_rental', '7513': 'car_rental', '7519': 'car_rental',
  '4511': 'travel', '4582': 'travel', '4722': 'travel', '7011': 'travel', '5309': 'travel',
  // жильё
  '4900': 'utilities',
  '5200': 'home', '5211': 'home', '5231': 'home', '5251': 'home', '5261': 'home',
  '5712': 'home', '5713': 'home', '5714': 'home', '5718': 'home', '5719': 'home', '7699': 'home',
  // связь
  '4812': 'mobile', '4814': 'mobile',
  '4816': 'internet', '4841': 'internet', '4899': 'internet',
  // развлечения
  '7911': 'entertainment', '7922': 'entertainment', '7929': 'entertainment',
  '7932': 'entertainment', '7933': 'entertainment', '7941': 'entertainment',
  '7991': 'entertainment', '7994': 'entertainment', '7996': 'entertainment',
  '7998': 'entertainment', '7999': 'entertainment', '5971': 'entertainment',
  '7829': 'cinema', '7832': 'cinema', '7841': 'cinema',
  '5815': 'music', '5816': 'music', '5817': 'music', '5818': 'music', '5735': 'music',
  '5940': 'sports', '5941': 'sports', '7997': 'sports',
  // здоровье
  '5122': 'pharmacy', '5912': 'pharmacy',
  '8011': 'medical', '8021': 'medical', '8031': 'medical', '8041': 'medical',
  '8042': 'medical', '8043': 'medical', '8049': 'medical', '8050': 'medical',
  '8062': 'medical', '8071': 'medical', '8099': 'medical', '4119': 'medical',
  '7230': 'beauty', '7297': 'beauty', '7298': 'beauty', '5977': 'beauty',
  // прочее
  '5611': 'clothing', '5621': 'clothing', '5631': 'clothing', '5651': 'clothing',
  '5655': 'clothing', '5661': 'clothing', '5681': 'clothing', '5691': 'clothing',
  '5697': 'clothing', '5698': 'clothing', '5699': 'clothing', '5137': 'clothing',
  '5139': 'clothing', '5948': 'clothing',
  '5944': 'jewelry', '5094': 'jewelry',
  '5045': 'electronics', '5722': 'electronics', '5732': 'electronics', '5734': 'electronics',
  '5262': 'marketplace', '5300': 'marketplace', '5310': 'marketplace', '5311': 'marketplace',
  '5331': 'marketplace', '5399': 'marketplace', '5964': 'marketplace', '5965': 'marketplace',
  '5969': 'marketplace',
  '0742': 'pets', '5995': 'pets',
  '5641': 'kids', '5945': 'kids',
  '5947': 'gifts', '5992': 'gifts', '5193': 'gifts',
  '5111': 'education', '5192': 'education', '5942': 'education', '5943': 'education',
  '8211': 'education', '8220': 'education', '8241': 'education', '8244': 'education',
  '8249': 'education', '8299': 'education',
  '8398': 'charity', '8641': 'charity', '8661': 'charity',
  '9211': 'taxes', '9222': 'taxes', '9223': 'taxes', '9311': 'taxes', '9399': 'taxes',
  '7211': 'services', '7216': 'services', '7217': 'services', '7251': 'services',
  '7261': 'services', '7276': 'services', '7277': 'services', '7278': 'services',
  '7295': 'services', '7299': 'services', '7311': 'services', '7333': 'services',
  '7338': 'services', '7339': 'services', '7342': 'services', '7349': 'services',
  '7372': 'services', '7379': 'services', '7392': 'services', '7393': 'services',
  '7395': 'services', '7399': 'services',
}

// Диапазоны, где у каждой компании свой код: перечислять сотни авиалиний и
// гостиничных сетей поимённо смысла нет
const MCC_RANGES: ReadonlyArray<{ from: number; to: number; hint: CategoryHint }> = [
  { from: 3000, to: 3299, hint: 'travel' }, // авиакомпании
  { from: 3500, to: 3999, hint: 'travel' }, // гостиничные сети
]

const MCC_FORMAT = /^\d{4}$/

/**
 * Подсказка по коду торговой точки; null — кода нет, он не MCC или незнаком.
 *
 * Проверка формата обязательна и не формальна: вместо MCC Т-Банк присылает у
 * переводов заглушки вида "0 0000", "9999 9999", "18 0018". Ровно четыре цифры
 * отсекают их все, не разбирая каждую поимённо.
 *
 * Коды снятия наличных и переводов (6010, 6011, 6536 и соседние) в таблицу
 * намеренно не входят: это виды операций, а не то, на что потрачены деньги, и
 * разбираются они отдельно.
 */
export function hintFromMcc(mcc: string | undefined): CategoryHint | null {
  if (mcc === undefined || !MCC_FORMAT.test(mcc)) return null
  // проверка на собственное свойство обязательна: таблица — обычный объект,
  // и ключ вроде "toString" достал бы из прототипа функцию вместо подсказки
  if (Object.hasOwn(MCC_TO_HINT, mcc)) return MCC_TO_HINT[mcc] ?? null
  const code = Number(mcc)
  for (const range of MCC_RANGES) {
    if (code >= range.from && code <= range.to) return range.hint
  }
  return null
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd collector && pnpm vitest run src/core/category-hints.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Линт и типы**

Run: `cd collector && pnpm lint && pnpm build`
Expected: без замечаний

- [ ] **Step 6: Коммит**

```bash
git add collector/src/core/category-hints.ts collector/src/core/category-hints.test.ts
git commit -m "Словарь подсказок о категории и перевод MCC в коннекторе"
```

---

### Task 8: Таблица Т-Банка и тест на полноту справочника

**Files:**
- Modify: `collector/src/plugins/tbank/map.ts` (рядом с `BANK_GROUP_TO_KIND`, строка ~183)
- Test: `collector/src/plugins/tbank/hints.test.ts`

Справочник банка получен целиком — 90 значений в `collector/tests/fixtures/tbank-category-list.json`. Тест требует, чтобы каждое имело либо подсказку, либо явную запись «игнорируем».

- [ ] **Step 1: Написать падающий тест**

Создать `collector/src/plugins/tbank/hints.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { CATEGORY_HINTS } from '../../core/category-hints'
import { BANK_CATEGORY_TO_HINT, IGNORED_BANK_CATEGORIES } from './map'

function dictionaryNames(): string[] {
  const path = fileURLToPath(new URL('../../../tests/fixtures/tbank-category-list.json', import.meta.url))
  const items = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ name: string }>
  return items.map((item) => item.name)
}

test('справочник банка разобран целиком', () => {
  // фикстура — не образец ответа, а обязательство: забыли строку — красный CI,
  // а не тихо некатегоризованная операция через полгода
  const uncovered = dictionaryNames().filter(
    (name) => !Object.hasOwn(BANK_CATEGORY_TO_HINT, name) && !IGNORED_BANK_CATEGORIES.has(name),
  )
  expect(uncovered).toEqual([])
})

test('ни одно значение не переведено и не игнорируется одновременно', () => {
  const both = Object.keys(BANK_CATEGORY_TO_HINT).filter((name) => IGNORED_BANK_CATEGORIES.has(name))
  expect(both).toEqual([])
})

test('таблица не переводит в подсказки вне словаря', () => {
  const known = new Set<string>(CATEGORY_HINTS)
  const unknown = Object.values(BANK_CATEGORY_TO_HINT).filter((hint) => !known.has(hint))
  expect(unknown).toEqual([])
})

test('в таблицах нет значений, которых у банка нет', () => {
  // устаревшая строка — след переименования у банка, и это повод посмотреть,
  // а не молча носить мёртвый ключ
  const names = new Set(dictionaryNames())
  const stale = [...Object.keys(BANK_CATEGORY_TO_HINT), ...IGNORED_BANK_CATEGORIES].filter(
    (name) => !names.has(name),
  )
  expect(stale).toEqual([])
})

test('справочник в фикстуре не усох', () => {
  // защита от подгонки фикстуры под таблицу вместо обратного
  expect(dictionaryNames().length).toBe(90)
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd collector && pnpm vitest run src/plugins/tbank/hints.test.ts`
Expected: FAIL — `map.ts` не экспортирует `BANK_CATEGORY_TO_HINT`

- [ ] **Step 3: Написать таблицы**

В `collector/src/plugins/tbank/map.ts`, после `resolveKind` (строка ~203):

```ts
// Второе — и последнее — место, где живёт словарь Т-Банка. Справочник банка
// (90 значений, ручка operations_category_list_bank) сжимается в наши 37
// подсказок: перевод один к одному завёл бы в дереве человека «Duty Free» и
// «Металлы в слитках», то есть словарь банка в чужом интерфейсе.
//
// Ключ — имя, а не id: таблицу правит человек, и она должна читаться.
// Переименование у банка соответствие порвёт, но не тихо — такая операция
// приедет без подсказки и попадёт в счётчик при сборе.
export const BANK_CATEGORY_TO_HINT: Record<string, CategoryHint> = {
  Супермаркеты: 'groceries',
  'Онлайн-супермаркеты': 'groceries',
  Булочные: 'groceries',
  Рестораны: 'dining',
  Фастфуд: 'dining',
  Такси: 'taxi',
  'Местный транспорт': 'transit',
  Транспорт: 'transit',
  Заправки: 'fuel',
  'Зарядка электромобилей': 'fuel',
  Парковки: 'parking',
  'Платные дороги': 'parking',
  Автомойки: 'car',
  Автоуслуги: 'car',
  Автосалоны: 'car',
  'Аренда авто': 'car_rental',
  Каршеринг: 'car_rental',
  Самокаты: 'car_rental',
  Авиабилеты: 'travel',
  'Ж/д билеты': 'travel',
  Турагентства: 'travel',
  Отели: 'travel',
  'Duty Free': 'travel',
  ЖКХ: 'utilities',
  'Ремонт и мебель': 'home',
  Охрана: 'home',
  'Мобильная связь': 'mobile',
  Телефония: 'mobile',
  Связь: 'mobile',
  Интернет: 'internet',
  Телевидение: 'internet',
  Развлечения: 'entertainment',
  Искусство: 'entertainment',
  Лотереи: 'entertainment',
  Соцсети: 'entertainment',
  Кино: 'cinema',
  'Онлайн-кинотеатры': 'cinema',
  Музыка: 'music',
  'Цифровые товары': 'music',
  Тренировки: 'sports',
  Спорттовары: 'sports',
  Аптеки: 'pharmacy',
  Медицина: 'medical',
  Красота: 'beauty',
  Косметика: 'beauty',
  'Одежда и обувь': 'clothing',
  'Одежда и обувь онлайн': 'clothing',
  'Ювелирные изделия и часы': 'jewelry',
  'Гаджеты и техника': 'electronics',
  'Интернет-магазины': 'marketplace',
  Маркетплейсы: 'marketplace',
  'Различные товары': 'marketplace',
  Животные: 'pets',
  'Детские товары': 'kids',
  Подарки: 'gifts',
  'Подарки и творчество': 'gifts',
  Цветы: 'gifts',
  Образование: 'education',
  'Книги и канцтовары': 'education',
  Канцтовары: 'education',
  Благотворительность: 'charity',
  НКО: 'charity',
  Налоги: 'taxes',
  Штрафы: 'taxes',
  Госуслуги: 'taxes',
  'Услуги банка': 'bank_fees',
  Комиссия: 'bank_fees',
  'Различные услуги': 'services',
  Сервис: 'services',
  'Нотариальные услуги': 'services',
  'Фото и копицентры': 'services',
  'Сетевой маркетинг': 'services',
  'Экосистема Сбер': 'ecosystem',
  'Экосистема Яндекс': 'ecosystem',
  Зарплата: 'salary',
  'Соцвыплаты и пенсии': 'benefits',
  Проценты: 'interest',
  'Дивиденды и купоны': 'interest',
  Бонусы: 'cashback',
}

// Значения справочника, которым подсказка не назначается намеренно. Список
// явный, а не «всё остальное»: молчаливый пропуск неотличим от забытой строки.
export const IGNORED_BANK_CATEGORIES: ReadonlySet<string> = new Set([
  // виды операций — разобраны resolveKind, категорией не являются
  'Переводы',
  'Наличные',
  'Пополнения',
  'Эл. кошельки и переводы',
  // перекладывание денег, а не трата
  'Вклады',
  'Инвестиции',
  'Металлы',
  'Металлы в слитках',
  'Финансы',
  // отдельный скоуп кредитных счетов
  'Кредиты',
  // бессодержательно по построению: у владельца этим помечены 167 операций из 167
  'Другое',
])
```

Импорт в начало `map.ts`: `import type { CategoryHint } from '../../core/category-hints'`. Только тип — `hintFromMcc` понадобится в Task 9, а неиспользуемый импорт уронил бы `pnpm lint` (он запускается с `--deny-warnings`).

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd collector && pnpm vitest run src/plugins/tbank/hints.test.ts`
Expected: PASS, 5 тестов. Если «справочник банка разобран целиком» падает — в списке будут точные имена, которых не хватает; дописать их в одну из двух таблиц, а не править фикстуру.

- [ ] **Step 5: Линт и типы**

Run: `cd collector && pnpm lint && pnpm build`
Expected: без замечаний

- [ ] **Step 6: Коммит**

```bash
git add collector/src/plugins/tbank/map.ts collector/src/plugins/tbank/hints.test.ts
git commit -m "Перевод справочника категорий Т-Банка в подсказки"
```

---

### Task 9: Подсказка доезжает до приложения

**Files:**
- Modify: `collector/src/plugins/tbank/types.ts:1-10` (`CollectedOperation`)
- Modify: `collector/src/plugins/tbank/map.ts` (`toOperation`, строка ~56)
- Modify: `collector/src/runner/main.ts:65-71` (рядом с `reportUnknownKinds`)
- Test: `collector/src/plugins/tbank/map.test.ts`

- [ ] **Step 1: Написать падающий тест**

Дописать в `collector/src/plugins/tbank/map.test.ts`:

```ts
function operation(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'OK',
    id: '1',
    operationTime: { milliseconds: '1756684800000' },
    accountAmount: { value: '100.00', currency: { name: 'RUB' } },
    type: 'Debit',
    description: 'Пятёрочка',
    ...extra,
  }
}

test('метка банка становится подсказкой', () => {
  const [op] = toOperations([operation({ spendingCategory: { id: '1', name: 'Супермаркеты' } })])
  expect(op?.category_hint).toBe('groceries')
})

test('без метки подсказка берётся из MCC', () => {
  const [op] = toOperations([operation({ mcc: '5812' })])
  expect(op?.category_hint).toBe('dining')
})

test('метка банка приоритетнее MCC', () => {
  // банк выводит метку из MCC плюс знания о самой точке — она информативнее
  const [op] = toOperations([
    operation({ spendingCategory: { id: '1', name: 'Такси' }, mcc: '5812' }),
  ])
  expect(op?.category_hint).toBe('taxi')
})

test('игнорируемая метка к MCC не проваливается', () => {
  // «Переводы» — решение, а не пробел: MCC у перевода всё равно заглушка
  const [op] = toOperations([
    operation({ spendingCategory: { id: '1', name: 'Переводы' }, mcc: '5812' }),
  ])
  expect(op?.category_hint).toBeNull()
})

test('незнакомая метка проваливается к MCC', () => {
  const [op] = toOperations([
    operation({ spendingCategory: { id: '1', name: 'Криптолавка' }, mcc: '5812' }),
  ])
  expect(op?.category_hint).toBe('dining')
})

test('без метки и без MCC подсказки нет', () => {
  const [op] = toOperations([operation({})])
  expect(op?.category_hint).toBeNull()
})
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd collector && pnpm vitest run src/plugins/tbank/map.test.ts`
Expected: FAIL — у операции нет поля `category_hint`

- [ ] **Step 3: Добавить поле и разрешение**

В `collector/src/plugins/tbank/types.ts`, в `CollectedOperation`, после `kind`:

```ts
  /** Подсказка о категории в словаре приложения; null — банк не подсказал. */
  category_hint: string | null
```

Тип `string`, а не `CategoryHint`, — по той же причине, что и у соседнего `kind`: `CollectedOperation` описывает то, что уезжает в приложение по HTTP, и словарём значение становится на входе в бэкенд.

В `collector/src/plugins/tbank/map.ts` дополнить импорт из Task 8, добавив к нему функцию перевода MCC:

```ts
import { hintFromMcc, type CategoryHint } from '../../core/category-hints'
```

В `collector/src/plugins/tbank/map.ts`, в `toOperation`, в возвращаемый объект после `kind: resolveKind(item),`:

```ts
    category_hint: resolveHint(item),
```

Там же, после `resolveKind`:

```ts
/**
 * Подсказка о категории: сперва собственная метка банка, затем MCC.
 *
 * Метка первая, потому что информативнее: банк выводит её из MCC плюс знания о
 * торговой точке, и на живых данных покрывает 163 операции из 167 против 26 у
 * MCC. Явно игнорируемая метка к MCC не проваливается: это решение, а не
 * пробел, и MCC у таких операций всё равно заглушка.
 *
 * Незнакомая метка — не повод останавливаться: банк вправе завести значение в
 * любой момент. Операция приедет без подсказки и попадёт в счётчик при сборе.
 */
function resolveHint(item: Record<string, unknown>): CategoryHint | null {
  const spending = getRecord(item, 'spendingCategory')
  const name = spending ? getStr(spending, 'name') : undefined
  if (name !== undefined) {
    // проверка на собственное свойство обязательна: таблица — обычный объект,
    // и метка вроде "toString" достала бы из прототипа функцию вместо подсказки
    if (Object.hasOwn(BANK_CATEGORY_TO_HINT, name)) return BANK_CATEGORY_TO_HINT[name] ?? null
    if (IGNORED_BANK_CATEGORIES.has(name)) return null
  }
  return hintFromMcc(getStr(item, 'mcc'))
}
```

- [ ] **Step 4: Добавить счётчик при сборе**

В `collector/src/runner/main.ts`, после `reportUnknownKinds`:

```ts
// Тест на полноту справочника ловит дырку в таблице, но только для той версии
// справочника, что лежит в фикстуре. Банк заведёт новую категорию — фикстура
// устареет молча, и заметно это станет только здесь, на живых данных
function reportMissingHints(appAccountId: string, operations: readonly CollectedOperation[]): void {
  const purchases = operations.filter((operation) => operation.kind === 'purchase')
  const count = purchases.filter((operation) => operation.category_hint === null).length
  if (count === 0) return
  console.log(`счёт ${appAccountId}: категория не определена у ${count} трат из ${purchases.length}`)
}
```

Вызвать сразу после `reportUnknownKinds(appAccountId, operations)` (`collector/src/runner/main.ts:58`) с теми же аргументами:

```ts
    reportMissingHints(appAccountId, operations)
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd collector && pnpm vitest run`
Expected: PASS — весь набор коллектора

- [ ] **Step 6: Линт и типы**

Run: `cd collector && pnpm lint && pnpm build`
Expected: без замечаний

- [ ] **Step 7: Коммит**

```bash
git add collector/src/plugins/tbank/types.ts collector/src/plugins/tbank/map.ts collector/src/runner/main.ts collector/src/plugins/tbank/map.test.ts
git commit -m "Коннектор отправляет подсказку о категории вместе с операцией"
```

---

### Task 10: Описать в README

**Files:**
- Modify: `README.md:20-41` (раздел «Что реализовано»)

- [ ] **Step 1: Дописать раздел**

В `README.md`, после абзаца «Категории запоминаются», добавить:

```markdown
- **Категорию подсказывает банк.** Банк уже знает, на что потрачены деньги, —
  мы принимаем его подсказку и переводим в свои слова: справочник банка на 90
  значений сжимается в 37 подсказок приложения, так что «Duty Free» и «Металлы
  в слитках» в дереве категорий не заводятся. Где своей метки у банка нет,
  работает MCC — международный код торговой точки, одинаковый во всех банках.
  Подкатегория создаётся при первой же операции с такой подсказкой, поэтому
  дерево пополняется только тем, на что вы действительно тратите. Порядок
  такой: ваше решение сильнее подсказки банка, подсказка банка сильнее догадки
  языковой модели — **и всё это работает без ключа к модели вообще**. Итоги на
  дашборде считаются по верхнему уровню категорий, детализация видна в ленте.
```

- [ ] **Step 2: Коммит**

```bash
git add README.md
git commit -m "README: категорию подсказывает банк"
```

---

## Финальная проверка

- [ ] **Прогнать всё**

```bash
cd backend && uv run ruff format --check . && uv run ruff check . && uv run mypy . && uv run lint-imports && uv run pytest -q
```

```bash
cd collector && pnpm lint && pnpm build && pnpm vitest run
```

```bash
cd frontend && pnpm lint && pnpm build && pnpm vitest run
```

- [ ] **Живой прогон**

Собрать операции из банка и подтвердить импорт в приложении. Ожидается: у трат
появились категории без единого обращения к языковой модели; в дереве завелись
подкатегории под «Едой», «Транспортом», «Жильём» и «Связью»; на дашборде
верхний уровень не распался. Счётчик «категория не определена у N трат»
показывает, сколько меток банка мы ещё не знаем.
