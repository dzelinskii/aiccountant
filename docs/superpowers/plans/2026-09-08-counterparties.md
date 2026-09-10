# Контрагент: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Объединить разные написания одного человека или организации в контрагента, чтобы категория задавалась один раз, а в ленте вместо банковской строки было имя.

**Architecture:** Контрагент — новая таблица; подписи остаются в существующей `description_rules`, у строки появляется ссылка на контрагента. Правило указывает либо на категорию напрямую, либо на контрагента — ровно одно из двух, ограничением на уровне БД. Приложение показывает неопознанные подписи и предлагает завести контрагента; сводит написания человек, не алгоритм.

**Tech Stack:** FastAPI / SQLAlchemy 2 async / Alembic / pytest; React 19 / TypeScript / Mantine / TanStack Query / vitest.

**Спека:** `docs/superpowers/specs/2026-09-08-counterparties-design.md`

---

## Структура файлов

**Бэкенд**

| файл | ответственность |
| --- | --- |
| `backend/app/ledger/models.py` (править) | модель `Counterparty`, `DescriptionRule.counterparty_id` |
| `backend/alembic/versions/0013_counterparties.py` (создать) | таблица, колонка, ограничение «ровно одно из двух» |
| `backend/app/ledger/repository.py` (править) | запросы по контрагентам, неопознанные подписи, разрешение правила |
| `backend/app/ledger/service.py` (править) | создание и правка контрагента, привязка подписей |
| `backend/app/ledger/schemas.py` (править) | схемы контрагента, имя контрагента у операции |
| `backend/app/ledger/router.py` (править) | ручки контрагентов и неопознанных подписей |
| `backend/tests/test_counterparties.py` (создать) | всё поведение контрагентов |

**Фронтенд**

| файл | ответственность |
| --- | --- |
| `frontend/src/api/ledger.ts` (править) | типы и вызовы ручек |
| `frontend/src/pages/CounterpartiesPage.tsx` (создать) | экран: неопознанные подписи и контрагенты |
| `frontend/src/pages/CounterpartiesPage.test.tsx` (создать) | поведение экрана |
| `frontend/src/main.tsx` (править) | маршрут |
| `frontend/src/AppLayout.tsx` (править) | пункт навигации |
| `frontend/src/pages/TransactionsPage.tsx` (править) | имя контрагента вместо банковской строки |

Сейчас: бэкенд 371 тест, фронт 45, коллектор 176. Коллектор в этой работе не участвует вовсе.

---

### Task 1: Модель контрагента и миграция

**Files:**
- Modify: `backend/app/ledger/models.py` (рядом с `DescriptionRule`, строка ~114)
- Create: `backend/alembic/versions/0013_counterparties.py`
- Modify: `backend/tests/test_migrations.py`

- [ ] **Step 1: Модель**

В `backend/app/ledger/models.py` перед `DescriptionRule`:

```python
class Counterparty(Base):
    """Тот, кому переводят или кто переводит: человек или организация.

    Заводится, чтобы разные написания одного и того же — «Денис З.» в одном
    банке, «ЗЕЛИНСКИЙ ДЕНИС» в другом — были одним объектом, и категория
    задавалась один раз, а не по разу на банк. Сами написания живут в
    description_rules: отдельная таблица подписей означала бы второй поиск по
    тому же ключу.
    """

    __tablename__ = "counterparties"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    name: Mapped[str] = mapped_column(String(200))
    # person | organization. Сегодня на поведение не влияет: заведён потому, что
    # у человека могут появиться свои счета, а у организации нет
    kind: Mapped[str] = mapped_column(String(20))
    # необязательная: переводы одному человеку бывают разными по смыслу, и
    # требовать одну категорию значит требовать соврать. Контрагент без
    # категории — просто имя вместо банковской строки
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

В `DescriptionRule` заменить `category_id` и добавить ссылку:

```python
    # ровно одно из двух: правило ведёт либо прямо в категорию («Пятёрочка»),
    # либо в контрагента, у которого категория своя («Денис З.»). Проверяет
    # ограничение в БД — иначе строка без обоих полей молча ничего не делала бы
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), nullable=True
    )
    counterparty_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("counterparties.id", ondelete="CASCADE"), nullable=True
    )
```

В `__table_args__` у `DescriptionRule` добавить к существующему `UniqueConstraint`:

```python
        CheckConstraint(
            "(category_id IS NULL) <> (counterparty_id IS NULL)",
            name="ck_description_rules_target",
        ),
```

Импорт `CheckConstraint` из `sqlalchemy` — дополнить существующий, не заводить второй.

- [ ] **Step 2: Миграция**

Последняя — `0012_category_hint.py`, посмотри её как образец. Создать `backend/alembic/versions/0013_counterparties.py`:

```python
"""Контрагент: объединяет разные написания одного и того же"""

import sqlalchemy as sa

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "counterparties",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column(
            "category_id",
            sa.Uuid(),
            sa.ForeignKey("categories.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_counterparties_workspace", "counterparties", ["workspace_id"])

    op.add_column(
        "description_rules",
        sa.Column(
            "counterparty_id",
            sa.Uuid(),
            sa.ForeignKey("counterparties.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    # существующие правила ведут прямо в категорию, и такими остаются;
    # послабление нужно, чтобы появились правила, ведущие в контрагента
    op.alter_column("description_rules", "category_id", nullable=True)
    op.create_check_constraint(
        "ck_description_rules_target",
        "description_rules",
        "(category_id IS NULL) <> (counterparty_id IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_description_rules_target", "description_rules", type_="check")
    # обратно в NOT NULL можно только выбросив правила, ведущие в контрагента:
    # категории у них нет, и подставить её неоткуда
    op.execute("DELETE FROM description_rules WHERE category_id IS NULL")
    op.alter_column("description_rules", "category_id", nullable=False)
    op.drop_column("description_rules", "counterparty_id")
    op.drop_index("ix_counterparties_workspace", table_name="counterparties")
    op.drop_table("counterparties")
```

- [ ] **Step 3: Тест на схему**

Порт Postgres наружу не проброшен, миграции накатывает контейнер бэкенда при старте — локальный `alembic upgrade` до базы проекта не достучится. Проверяются они через `backend/tests/test_migrations.py`, который смотрит схему на базе от testcontainers. **Прочитай файл целиком** и допиши в конце:

```python
async def test_migrations_add_counterparties(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        cols = await conn.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'counterparties'"
            )
        )
        counterparty = {name: nullable for name, nullable in cols.all()}
        rule_cols = await conn.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'description_rules' "
                "AND column_name IN ('category_id', 'counterparty_id')"
            )
        )
        rule = {name: nullable for name, nullable in rule_cols.all()}
        check = await conn.execute(
            text(
                "SELECT count(*) FROM pg_constraint "
                "WHERE conname = 'ck_description_rules_target' AND contype = 'c'"
            )
        )
        has_check = check.scalar()
    await engine.dispose()
    # категория у контрагента необязательна: он может быть просто именем
    assert counterparty["category_id"] == "YES"
    assert counterparty["name"] == "NO"
    assert counterparty["kind"] == "NO"
    # у правила обе цели необязательны по отдельности, а «ровно одна из двух»
    # держится ограничением — без него строка без обеих молча ничего не делала бы
    assert rule == {"category_id": "YES", "counterparty_id": "YES"}
    assert has_check == 1
```

Run: `cd backend && uv run pytest tests/test_migrations.py -v`
Expected: PASS, включая новый.

- [ ] **Step 4: Обратимость на одноразовой базе**

Базу владельца не трогаем. Поднять свою (порт подобрать свободный, 55432 может быть занят):

```bash
docker run --rm -d --name mr-mig -p 55432:5432 -e POSTGRES_USER=aiccountant -e POSTGRES_PASSWORD=x -e POSTGRES_DB=aiccountant postgres:16
```

Дождаться `docker exec mr-mig pg_isready -U aiccountant`, затем из `backend/`:

```bash
DATABASE_URL=postgresql+asyncpg://aiccountant:x@localhost:55432/aiccountant uv run alembic upgrade head
DATABASE_URL=postgresql+asyncpg://aiccountant:x@localhost:55432/aiccountant uv run alembic downgrade -1
DATABASE_URL=postgresql+asyncpg://aiccountant:x@localhost:55432/aiccountant uv run alembic upgrade head
```

Expected: три команды без ошибок, в выводе первой `Running upgrade 0012 -> 0013`. После — `docker rm -f mr-mig` обязательно, даже если что-то пошло не так.

- [ ] **Step 5: Линт, типы, границы**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports`
Expected: без замечаний, `Contracts: 7 kept, 0 broken`.

- [ ] **Step 6: Весь бэкенд**

Run: `cd backend && uv run pytest -q`
Expected: PASS. До тебя был 371 тест.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/ledger/models.py backend/alembic/versions/0013_counterparties.py backend/tests/test_migrations.py
git commit -m "Контрагент: таблица и ссылка из правила"
```

---

### Task 2: Правило через контрагента даёт категорию

**Files:**
- Modify: `backend/app/ledger/repository.py:181-200` (`description_rule_targets`)
- Create: `backend/tests/test_counterparties.py`

Смысл: правило, ведущее в контрагента, должно давать его категорию — иначе задать её один раз не выйдет. Правило, ведущее в контрагента **без** категории, не даёт ничего: имя есть, категории нет, и это законный случай.

- [ ] **Step 1: Падающие тесты**

Создать `backend/tests/test_counterparties.py`. Фикстуры в проекте — `client` и `db_session`, workspace создаётся регистрацией через API, `asyncio_mode = "auto"`, декораторы не нужны. Образец — `backend/tests/test_description_rules.py`, **прочитай его**.

```python
import uuid
from decimal import Decimal
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import service as ledger_service
from app.ledger.models import Counterparty, DescriptionRule

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


async def _expense_category(client: AsyncClient, ws: str) -> str:
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    return str(next(c for c in cats if c["kind"] == "expense")["id"])


def _add_counterparty(
    db: AsyncSession, ws: str, name: str, category_id: str | None
) -> Counterparty:
    cp = Counterparty(
        workspace_id=uuid.UUID(ws),
        name=name,
        kind="person",
        category_id=None if category_id is None else uuid.UUID(category_id),
    )
    db.add(cp)
    return cp


async def test_rule_through_counterparty_gives_its_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    cp = _add_counterparty(db_session, ws, "Денис З.", category)
    await db_session.flush()
    db_session.add(
        DescriptionRule(workspace_id=uuid.UUID(ws), normalized_text="денис з.", counterparty_id=cp.id)
    )
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    assert ledger_service.category_for_description(
        rules, "Денис З.", Decimal("-100.00")
    ) == uuid.UUID(category)


async def test_two_signatures_of_one_counterparty_give_the_same_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Ради этого всё и затевается: категория задана один раз, а написаний
    столько, сколько банков."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    cp = _add_counterparty(db_session, ws, "Денис З.", category)
    await db_session.flush()
    for text in ("денис з.", "зелинский денис"):
        db_session.add(
            DescriptionRule(
                workspace_id=uuid.UUID(ws), normalized_text=text, counterparty_id=cp.id
            )
        )
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    first = ledger_service.category_for_description(rules, "Денис З.", Decimal("-100.00"))
    second = ledger_service.category_for_description(
        rules, "ЗЕЛИНСКИЙ ДЕНИС", Decimal("-100.00")
    )
    assert first == second == uuid.UUID(category)


async def test_counterparty_without_category_gives_no_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Законный случай, а не пробел: контрагент может быть просто именем."""
    ws, _ = await _register(client, ALICE)
    cp = _add_counterparty(db_session, ws, "Денис З.", None)
    await db_session.flush()
    db_session.add(
        DescriptionRule(workspace_id=uuid.UUID(ws), normalized_text="денис з.", counterparty_id=cp.id)
    )
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    assert ledger_service.category_for_description(rules, "Денис З.", Decimal("-100.00")) is None


async def test_plain_rule_still_works(client: AsyncClient, db_session: AsyncSession) -> None:
    """Существующие правила ведут прямо в категорию и такими остаются."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Пятёрочка", uuid.UUID(category)
    )

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    assert ledger_service.category_for_description(
        rules, "пятёрочка", Decimal("-100.00")
    ) == uuid.UUID(category)


async def test_counterparty_of_another_workspace_is_invisible(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws_alice, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws_alice)
    cp = _add_counterparty(db_session, ws_alice, "Денис З.", category)
    await db_session.flush()
    db_session.add(
        DescriptionRule(
            workspace_id=uuid.UUID(ws_alice), normalized_text="денис з.", counterparty_id=cp.id
        )
    )
    await db_session.flush()

    ws_bob, _ = await _register(client, BOB)
    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws_bob))
    assert rules == {}
```

Переключение на второго пользователя работает так же, как в `backend/tests/test_learned_rules.py:230`: у `client` держится сессия, и регистрация второго её меняет.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && uv run pytest tests/test_counterparties.py -v`
Expected: FAIL — `description_rule_targets` присоединяет категорию через `join` по `DescriptionRule.category_id`, поэтому правила через контрагента просто не попадают в выборку.

- [ ] **Step 3: Разрешать обе цели**

Заменить `description_rule_targets` в `backend/app/ledger/repository.py`:

```python
async def description_rule_targets(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[str, uuid.UUID, str]]:
    """Ключ правила, его категория и направление категории — для применения
    правил к пачке операций без запроса на каждую строку.

    Правило ведёт либо прямо в категорию, либо в контрагента, у которого
    категория своя; берём ту, что нашлась. Контрагент без категории — законный
    случай (он может быть просто именем), и такое правило в выборку не попадает:
    подставлять из него нечего.

    Категорию присоединяем с тем же фильтром по workspace: правило и категория
    чужого workspace связаны только друг с другом, и одна снятая проверка
    не должна открывать вторую. Контрагента — по той же причине.
    """
    own = aliased(Category)
    via = aliased(Category)
    counterparty = aliased(Counterparty)
    category_id = func.coalesce(own.id, via.id)
    kind = func.coalesce(own.kind, via.kind)
    rows = await db.execute(
        select(DescriptionRule.normalized_text, category_id, kind)
        .outerjoin(
            own,
            (own.id == DescriptionRule.category_id) & (own.workspace_id == workspace_id),
        )
        .outerjoin(
            counterparty,
            (counterparty.id == DescriptionRule.counterparty_id)
            & (counterparty.workspace_id == workspace_id),
        )
        .outerjoin(via, (via.id == counterparty.category_id) & (via.workspace_id == workspace_id))
        .where(DescriptionRule.workspace_id == workspace_id, category_id.is_not(None))
    )
    return [(text, cid, k) for text, cid, k in rows.all()]
```

Импорты в начало файла: `aliased` из `sqlalchemy.orm` (уже есть, добавлен в работе по дашборду), `Counterparty` — дополнить существующий импорт моделей.

- [ ] **Step 4: Тесты проходят**

Run: `cd backend && uv run pytest tests/test_counterparties.py tests/test_description_rules.py tests/test_learned_rules.py -v`
Expected: PASS. Прежние тесты правил обязаны остаться целыми: правило, ведущее прямо в категорию, работает как работало.

- [ ] **Step 5: Линт, типы, границы**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports`
Expected: без замечаний.

- [ ] **Step 6: Весь бэкенд**

Run: `cd backend && uv run pytest -q`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/ledger/repository.py backend/tests/test_counterparties.py
git commit -m "Правило через контрагента отдаёт его категорию"
```

---

### Task 3: Неопознанные подписи

**Files:**
- Modify: `backend/app/ledger/repository.py` (рядом с `description_rule_targets`)
- Modify: `backend/app/ledger/service.py`
- Modify: `backend/app/ledger/schemas.py`
- Modify: `backend/app/ledger/router.py`
- Test: `backend/tests/test_counterparties.py`

Смысл: экран заведения контрагентов должен показать, из чего выбирать. Неопознанная подпись — описание переводов, у которого **нет правила**: ни в категорию, ни в контрагента. Рядом — сколько операций, сколько отдано и сколько получено, чтобы человек узнал, кто это.

Сумм не отдаём: для узнавания достаточно счётчиков, а деньги на проводе требуют строк и лишней осторожности там, где они не нужны.

- [ ] **Step 1: Падающие тесты**

Дописать в `backend/tests/test_counterparties.py`:

```python
async def _import_transfer(client: AsyncClient, ws: str, acc: str, text: str, amount: str) -> None:
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "test_collector",
            "operations": [
                {
                    "occurred_at": "2026-09-01",
                    "amount": amount,
                    "currency": "RUB",
                    "description": text,
                    "external_id": f"op-{text}-{amount}",
                    "kind": "transfer_person",
                }
            ],
        },
    )
    assert started.status_code == 201
    committed = await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.status_code == 200


async def _unknown_signatures(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/counterparties/unknown-signatures", params={"workspace_id": ws})
    assert resp.status_code == 200
    items: list[dict[str, Any]] = resp.json()
    return items


async def test_unknown_signatures_count_both_directions(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "Денис З.", "-200.00")
    await _import_transfer(client, ws, acc, "Денис З.", "300.00")

    assert await _unknown_signatures(client, ws) == [
        {"text": "денис з.", "operations": 3, "sent": 2, "received": 1}
    ]


async def test_signature_with_a_rule_is_not_offered(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подпись, про которую уже решили, предлагать незачем."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Денис З.", uuid.UUID(category)
    )
    await db_session.flush()

    assert await _unknown_signatures(client, ws) == []


async def test_only_person_transfers_are_offered(client: AsyncClient) -> None:
    """Покупки в контрагенты не заводим: категории для них приходят подсказкой
    банка, и вручную их называть незачем."""
    ws, acc = await _register(client, ALICE)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "test_collector",
            "operations": [
                {
                    "occurred_at": "2026-09-01",
                    "amount": "-100.00",
                    "currency": "RUB",
                    "description": "Пятёрочка",
                    "external_id": "op-1",
                    "kind": "purchase",
                }
            ],
        },
    )
    assert started.status_code == 201
    await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )

    assert await _unknown_signatures(client, ws) == []


async def test_unknown_signatures_do_not_leak_between_workspaces(client: AsyncClient) -> None:
    ws_alice, acc_alice = await _register(client, ALICE)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")
    ws_bob, _ = await _register(client, BOB)

    assert await _unknown_signatures(client, ws_bob) == []
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && uv run pytest tests/test_counterparties.py -k signature -v`
Expected: FAIL — ручки `/api/counterparties/unknown-signatures` нет, ответ 404.

- [ ] **Step 3: Запрос**

В `backend/app/ledger/repository.py` после `description_rule_targets`:

```python
async def unknown_transfer_signatures(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[str, int, int, int]]:
    """Описания переводов, про которые ещё не решили: ключ, сколько операций,
    сколько отдано, сколько получено.

    Ключ — то же нормализованное описание, по которому ищется правило: иначе
    человек завёл бы контрагента на подпись, которая с правилом не совпадёт.
    Нормализацию делает Postgres теми же тремя действиями, что и
    normalize_description — приведение к нижнему регистру, схлопывание пробелов,
    обрезка краёв; расхождение здесь закреплено тестом.

    Берём только переводы людям: покупки в контрагенты не заводим, категории для
    них приходят подсказкой банка.
    """
    normalized = func.btrim(func.regexp_replace(func.lower(Transaction.merchant), r"\s+", " ", "g"))
    sent = func.count().filter(Transaction.amount < 0)
    received = func.count().filter(Transaction.amount > 0)
    rows = await db.execute(
        select(normalized, func.count(), sent, received)
        .outerjoin(
            DescriptionRule,
            (DescriptionRule.normalized_text == normalized)
            & (DescriptionRule.workspace_id == workspace_id),
        )
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.operation_kind == "transfer_person",
            Transaction.merchant.is_not(None),
            DescriptionRule.id.is_(None),
        )
        .group_by(normalized)
        .order_by(func.count().desc(), normalized)
    )
    return [(text, total, s, r) for text, total, s, r in rows.all()]
```

- [ ] **Step 4: Сервис, схема, ручка**

В `backend/app/ledger/service.py`:

```python
async def unknown_transfer_signatures(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[str, int, int, int]]:
    """Из чего человеку выбирать, заводя контрагента."""
    return await repository.unknown_transfer_signatures(db, workspace_id)
```

В `backend/app/ledger/schemas.py`:

```python
class UnknownSignatureOut(BaseModel):
    """Подпись переводов, про которую ещё не решили. Сумм здесь нет намеренно:
    для узнавания человека довольно счётчиков."""

    text: str
    operations: int
    sent: int
    received: int
```

В `backend/app/ledger/router.py` рядом с ручками правил:

```python
@router.get("/counterparties/unknown-signatures")
async def list_unknown_signatures(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[UnknownSignatureOut]:
    rows = await service.unknown_transfer_signatures(db, workspace_id)
    return [
        UnknownSignatureOut(text=text, operations=total, sent=sent, received=received)
        for text, total, sent, received in rows
    ]
```

Импорты дополнить существующие, не заводить вторые.

- [ ] **Step 5: Тест на согласие нормализаций**

Нормализация в SQL и в Python — две реализации одного правила, и разойтись им нельзя: человек завёл бы контрагента на подпись, которая правилу не соответствует. Дописать в `backend/tests/test_counterparties.py`:

```python
async def test_sql_normalization_matches_python(client: AsyncClient, db_session: AsyncSession) -> None:
    """Ключ из ручки обязан совпасть с ключом, по которому ищется правило.
    Две реализации одного правила — в SQL и в Python — разойтись не должны."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "  ДЕНИС   З.  ", "-100.00")

    signatures = await _unknown_signatures(client, ws)
    assert [s["text"] for s in signatures] == [ledger_service.normalize_description("  ДЕНИС   З.  ")]
```

- [ ] **Step 6: Тесты проходят**

Run: `cd backend && uv run pytest tests/test_counterparties.py -v`
Expected: PASS.

- [ ] **Step 7: Линт, типы, границы, весь бэкенд**

```bash
cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports && uv run pytest -q
```

- [ ] **Step 8: Коммит**

```bash
git add backend/app/ledger/repository.py backend/app/ledger/service.py backend/app/ledger/schemas.py backend/app/ledger/router.py backend/tests/test_counterparties.py
git commit -m "Неопознанные подписи переводов: из чего заводить контрагента"
```

---

### Task 4: Завести и править контрагента

**Files:**
- Modify: `backend/app/ledger/repository.py`, `service.py`, `schemas.py`, `router.py`
- Test: `backend/tests/test_counterparties.py`

Ручки: список контрагентов, создание с набором подписей, правка имени и категории, удаление.

Создание принимает имя, тип и список подписей. Подписи нормализуются и заводятся правилами, ведущими в контрагента. Подпись, у которой правило уже есть, — ошибка 409: молча переподчинить её значило бы отобрать решение, которое человек уже принял.

- [ ] **Step 1: Падающие тесты**

Дописать в `backend/tests/test_counterparties.py`:

```python
async def _create_counterparty(
    client: AsyncClient, ws: str, name: str, texts: list[str], category_id: str | None = None
) -> dict[str, Any]:
    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={"name": name, "kind": "person", "category_id": category_id, "signatures": texts},
    )
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def test_creating_counterparty_binds_signatures(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "ЗЕЛИНСКИЙ ДЕНИС", "-200.00")

    created = await _create_counterparty(
        client, ws, "Денис", ["денис з.", "зелинский денис"]
    )
    assert created["signatures"] == ["денис з.", "зелинский денис"]
    # подписи опознаны — предлагать их больше нечего
    assert await _unknown_signatures(client, ws) == []


async def test_counterparty_without_category_is_allowed(client: AsyncClient) -> None:
    """Переводы одному человеку бывают разными по смыслу; требовать категорию
    значит требовать соврать."""
    created = await _create_counterparty(
        client, (await _register(client, ALICE))[0], "Денис", ["денис з."]
    )
    assert created["category_id"] is None


async def test_taken_signature_is_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    """Подпись с готовым правилом молча не переподчиняем: решение уже принято."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "денис з.", uuid.UUID(category)
    )
    await db_session.flush()

    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={"name": "Денис", "kind": "person", "category_id": None, "signatures": ["денис з."]},
    )
    assert resp.status_code == 409


async def test_counterparty_category_can_be_changed(client: AsyncClient) -> None:
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    created = await _create_counterparty(client, ws, "Денис", ["денис з."])

    resp = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws},
        json={"category_id": category},
    )
    assert resp.status_code == 200
    assert resp.json()["category_id"] == category


async def test_deleting_counterparty_frees_its_signatures(client: AsyncClient) -> None:
    """Правила уходят вместе с контрагентом — иначе остались бы строки,
    не ведущие никуда, а ограничение в БД такого не допускает."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."])

    resp = await client.delete(
        f"/api/counterparties/{created['id']}", params={"workspace_id": ws}
    )
    assert resp.status_code == 204
    assert [s["text"] for s in await _unknown_signatures(client, ws)] == ["денис з."]


async def test_counterparty_of_another_workspace_is_not_reachable(client: AsyncClient) -> None:
    ws_alice, _ = await _register(client, ALICE)
    created = await _create_counterparty(client, ws_alice, "Денис", ["денис з."])
    ws_bob, _ = await _register(client, BOB)

    resp = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws_bob},
        json={"category_id": None},
    )
    assert resp.status_code == 404
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && uv run pytest tests/test_counterparties.py -k counterpart -v`
Expected: FAIL — ручек нет, 404/405.

- [ ] **Step 3: Реализация**

Схемы в `backend/app/ledger/schemas.py`:

```python
CounterpartyKind = Literal["person", "organization"]


class CounterpartyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: CounterpartyKind
    # необязательная: контрагент может быть просто именем в ленте
    category_id: uuid.UUID | None = None
    signatures: list[str] = Field(default_factory=list, max_length=50)


class CounterpartyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    category_id: uuid.UUID | None = None


class CounterpartyOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    category_id: uuid.UUID | None
    signatures: list[str]
```

Сервис в `backend/app/ledger/service.py` — функции `list_counterparties`, `create_counterparty`, `update_counterparty`, `delete_counterparty`. Создание: нормализовать каждую подпись через `normalize_description`, пустую или слишком длинную — `InvalidRuleTextError`; занятую — `DuplicateRuleError`; категорию, если задана, проверить через `repository.get_category` (чужая — `NotFoundError`).

Ручки в `backend/app/ledger/router.py`: `GET /counterparties`, `POST /counterparties` (201), `PATCH /counterparties/{id}`, `DELETE /counterparties/{id}` (204). Ошибки переводить так же, как у правил: `InvalidRuleTextError` → 422, `DuplicateRuleError` → 409, `NotFoundError` → 404.

**Важно:** `GET /counterparties/unknown-signatures` из Task 3 должен стоять в файле **выше** `GET /counterparties/{id}`, иначе FastAPI сопоставит `unknown-signatures` с параметром пути и ответит 422. Если решишь заводить `GET /counterparties/{id}` — проверь порядок; если не заводишь, всё равно проверь, что существующая ручка отвечает.

- [ ] **Step 4: Тесты, линт, типы, границы, весь бэкенд**

```bash
cd backend && uv run pytest tests/test_counterparties.py -v
cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports && uv run pytest -q
```

- [ ] **Step 5: Коммит**

```bash
git add backend/app/ledger backend/tests/test_counterparties.py
git commit -m "Ручки контрагентов: завести, поправить, удалить"
```

---

### Task 5: Имя контрагента в ответе по операциям

**Files:**
- Modify: `backend/app/ledger/repository.py` (список операций), `schemas.py` (`TransactionOut`), `router.py` (`_transaction_out`)
- Test: `backend/tests/test_counterparties.py`

Смысл: лента должна показать имя, а не банковскую строку. Банковская строка при этом остаётся в `merchant` — она то, что прислал банк, и подменять её нельзя, иначе потом не разобраться, почему подпись сопоставилась.

- [ ] **Step 1: Падающий тест**

```python
async def test_transaction_carries_counterparty_name(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _create_counterparty(client, ws, "Денис Зелинский", ["денис з."])

    items = (await client.get("/api/transactions", params={"workspace_id": ws})).json()["items"]
    assert items[0]["counterparty_name"] == "Денис Зелинский"
    # банковская строка на месте: она — то, что прислал банк
    assert items[0]["merchant"] == "Денис З."


async def test_transaction_without_counterparty_has_none(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Кто-то", "-100.00")

    items = (await client.get("/api/transactions", params={"workspace_id": ws})).json()["items"]
    assert items[0]["counterparty_name"] is None
```

- [ ] **Step 2: Реализация**

В `TransactionOut` добавить `counterparty_name: str | None`. Запрос списка операций присоединяет правило по нормализованному описанию и контрагента по правилу — тем же выражением нормализации, что в Task 3; вынеси его в модульную функцию репозитория и используй в обоих местах, чтобы не разошлись.

- [ ] **Step 3: Тесты, проверки, коммит**

```bash
cd backend && uv run pytest -q && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run lint-imports
git add backend/app/ledger backend/tests/test_counterparties.py
git commit -m "Операция несёт имя контрагента рядом с банковской строкой"
```

---

### Task 6: Экран контрагентов

**Files:**
- Modify: `frontend/src/api/ledger.ts`
- Create: `frontend/src/pages/CounterpartiesPage.tsx`, `frontend/src/pages/CounterpartiesPage.test.tsx`
- Modify: `frontend/src/main.tsx` (маршрут `/counterparties`), `frontend/src/AppLayout.tsx` (пункт «Контрагенты»)

**Правила фронта в этом проекте:** oxlint (не eslint), vitest с выключенными глобалами — импортируй `{ expect, test, vi }` явно; `@testing-library/jest-dom` **нет**, используй `.toBeDefined()` / `.toBeNull()`; компонент в тесте оборачивай в `<MantineProvider>`. Образец — `frontend/src/pages/AccountsPage.test.tsx`, **прочитай его**.

Экран показывает два блока: неопознанные подписи (текст, число операций, отдано/получено, кнопка «Завести контрагента») и список заведённых контрагентов с их подписями и категорией.

Форма заведения: имя, тип (человек / организация), необязательная категория, отметки на подписях — какие ещё относятся к тому же контрагенту.

- [ ] **Step 1: Клиент API**

В `frontend/src/api/ledger.ts` — типы `UnknownSignature`, `Counterparty` и вызовы `getUnknownSignatures`, `getCounterparties`, `createCounterparty`, `updateCounterparty`, `deleteCounterparty`. Форма — как у соседних функций в файле.

- [ ] **Step 2: Падающие тесты экрана**

Тесты: список подписей отрисован с числами; заведение контрагента отправляет выбранные подписи; после успеха список подписей обновляется. Запросы подменяй так же, как в `AccountsPage.test.tsx`.

- [ ] **Step 3: Экран, маршрут, навигация**

- [ ] **Step 4: Проверки и коммит**

```bash
cd frontend && pnpm lint && pnpm vitest run
git add frontend/src
git commit -m "Экран контрагентов: неопознанные подписи и заведение"
```

---

### Task 7: Имя контрагента в ленте операций

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx`
- Test: `frontend/src/pages/TransactionsPage.test.tsx`

В колонке контрагента показывать `counterparty_name`, если он есть, иначе `merchant`. Банковскую строку не прятать совсем — она нужна, чтобы понять, откуда взялось имя; показать её второй строкой мелким шрифтом или в подсказке.

- [ ] **Step 1: Падающий тест** — операция с `counterparty_name` показывает имя; без него показывает `merchant`.
- [ ] **Step 2: Реализация**
- [ ] **Step 3: Проверки и коммит**

```bash
cd frontend && pnpm lint && pnpm vitest run
git add frontend/src/pages
git commit -m "Лента показывает имя контрагента"
```

---

### Task 8: README

**Files:**
- Modify: `README.md` (раздел «Что реализовано»)

- [ ] **Step 1: Дописать абзац**

```markdown
- **Контрагенты.** Один и тот же человек подписан в разных банках по-разному —
  «Денис З.», «ЗЕЛИНСКИЙ ДЕНИС». Приложение показывает подписи, про которые ещё
  не решили, а вы объединяете их в контрагента: категория задаётся один раз, а
  в ленте вместо банковской строки видно имя. Сводить написания автоматически
  приложение не берётся — ошибка здесь означает чужие деньги в чужой категории.
  Категория у контрагента необязательна: переводы одному человеку бывают разными
  по смыслу, и требовать одну значит требовать соврать.
```

- [ ] **Step 2: Коммит**

```bash
git add README.md
git commit -m "README: контрагенты"
```

---

## Финальная проверка

```bash
cd backend && uv run ruff format --check . && uv run ruff check . && uv run mypy . && uv run lint-imports && uv run pytest -q
cd frontend && pnpm lint && pnpm vitest run
cd collector && pnpm lint && pnpm build && pnpm vitest run
```

Коллектор в этой работе не участвует — прогон нужен только чтобы убедиться, что его не задели.

**Живой прогон.** На данных владельца завести контрагента «Денис З.» (27 операций) и убедиться: подпись исчезла из неопознанных, в ленте появилось имя, категория — если задана — проставилась только у операций без категории.
