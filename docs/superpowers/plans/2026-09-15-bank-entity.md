# Банк у счёта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** счёт приложения знает свой банк и свой счёт в банке, а привязка живёт в базе, а не в переменной окружения коллектора.

**Architecture:** словарь банков — константа ядра (`app/core/banks.py`), у `accounts` появляются `bank_code` и `bank_account_fingerprint`, непривязанные счета банка лежат в отдельной таблице `discovered_accounts`. Коллектор в начале сбора шлёт `PUT /api/accounts/discovered` со списком счетов банка (сырой идентификатор заменён на sha256-отпечаток) и получает в ответ соответствие «отпечаток → счёт приложения». Фронт группирует список счетов по банку и заводит счёт из непривязанного.

**Tech Stack:** FastAPI + SQLAlchemy 2 + Alembic + pytest (backend), TypeScript + vitest (collector), React 19 + Mantine + vitest (frontend).

**Спека:** `docs/superpowers/specs/2026-09-15-bank-entity-design.md` — читать целиком до первой задачи.

**Где работаем:** worktree `.claude/worktrees/bank-entity`, ветка `spec/bank-entity`. Все команды ниже — из корня worktree, если не сказано иное.

---

## Карта файлов

**Backend**

| Файл | Ответственность |
|---|---|
| `backend/app/core/banks.py` | создаётся: словарь «код банка → название», список кодов, шаблон для схем |
| `backend/scripts/gen_reference.py` | правится: словарь банков печатается в `vocabularies.md` |
| `backend/alembic/versions/0014_bank_on_account.py` | создаётся: колонки у `accounts`, таблица `discovered_accounts`, индексы |
| `backend/app/ledger/models.py` | правится: две колонки в `Account`, модель `DiscoveredAccount` |
| `backend/app/ledger/schemas.py` | правится: банк в `AccountCreate`/`AccountOut`, схемы увиденных счетов, `BankOut` |
| `backend/app/ledger/repository.py` | правится: чтение/замена увиденных счетов, привязки по банку |
| `backend/app/ledger/service.py` | правится: `sync_discovered`, `list_discovered`, привязка в `create_account` |
| `backend/app/ledger/router.py` | правится: `GET /api/banks`, `PUT` и `GET /api/accounts/discovered`, банк в ответе счёта |
| `backend/app/core/money.py` | правится: `Money` и запрет float переезжают сюда из `imports/schemas.py` — два модуля теперь принимают деньги на вход |
| `backend/tests/test_migrations.py` | правится: проверки новой схемы, по образцу соседних |
| `backend/tests/test_bank_accounts.py` | создаётся: словарь банков и весь новый контракт API |

**Collector**

| Файл | Ответственность |
|---|---|
| `collector/src/runner/fingerprint.ts` | создаётся: sha256-отпечаток счёта банка |
| `collector/src/runner/discovered.ts` | создаётся: клиент ручки `PUT /api/accounts/discovered` |
| `collector/src/runner/config.ts` | правится: `accountMap` и его разбор уходят |
| `collector/src/runner/main.ts` | правится: привязки берутся из приложения, подсказка про переменную уходит |

**Frontend**

| Файл | Ответственность |
|---|---|
| `frontend/src/api/ledger.ts` | правится: банк в `Account`, `getBanks`, `getDiscovered`, банк в `createAccount` |
| `frontend/src/lib/account.ts` | правится: группировка счетов по банку |
| `frontend/src/pages/AccountsPage.tsx` | правится: группы, блок непривязанных, выбор банка в форме |

**Документация**

| Файл | Ответственность |
|---|---|
| `docs/reference/ledger.md` | правится: банк у счёта, привязка, увиденные счета |
| `docs/reference/collector.md` | правится: откуда коллектор берёт счета |
| `collector/README.md` | правится: переменная `AICCOUNTANT_ACCOUNTS` больше не нужна |
| `docs/reference/generated/*` | перегенерируется, руками не правится |

---

## Task 1: Словарь банков

**Files:**
- Create: `backend/app/core/banks.py`
- Modify: `backend/scripts/gen_reference.py`
- Test: `backend/tests/test_bank_accounts.py`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/tests/test_bank_accounts.py`:

```python
from app.core.banks import BANK_CODES, BANKS


def test_bank_code_has_human_name() -> None:
    """Код банка живёт в коде, название — рядом с ним: два списка в разных
    местах разъехались бы, и фронт показал бы не тот банк."""
    assert BANKS["alfa"] == "Альфа-Банк"
    assert set(BANK_CODES) == {"tbank", "sber", "alfa"}
```

- [ ] **Step 2: Прогнать тест и увидеть падение**

```bash
cd backend && uv run pytest tests/test_bank_accounts.py -v
```

Ожидаемо: `ModuleNotFoundError: No module named 'app.core.banks'`.

- [ ] **Step 3: Написать словарь**

Создать `backend/app/core/banks.py`:

```python
# Банки, которые приложение узнаёт. Код обязан совпадать с именем плагина
# коллектора (collector/src/plugins/registry.ts, BANK_NAMES): по нему и только
# по нему приложение и коллектор понимают, что речь об одном банке.
#
# Словарь, а не таблица в БД: список банков — это реестр плагинов, а не данные
# пользователя. Экран заведения банков дал бы «Сбер» и «Сбербанк» двумя
# строками, из которых не видно, в какую ходит коллектор.
BANKS: dict[str, str] = {
    "tbank": "Т-Банк",
    "sber": "Сбербанк",
    "alfa": "Альфа-Банк",
}

# Тот же словарь ключами — для проверок на входе и перечисления в UI.
BANK_CODES: tuple[str, ...] = tuple(BANKS)

# Шаблон для схем и параметров запроса: код приходит строкой и от коллектора,
# и из формы, и незнакомый должен получать отказ, а не тихо записываться.
BANK_CODE_PATTERN = "^(" + "|".join(BANK_CODES) + ")$"
```

- [ ] **Step 4: Прогнать тест и увидеть, что он проходит**

```bash
cd backend && uv run pytest tests/test_bank_accounts.py -v
```

Ожидаемо: 1 passed.

- [ ] **Step 5: Добавить банки в генерацию справочника**

В `backend/scripts/gen_reference.py` дописать импорт рядом с существующими (после `from app.core.category_hints import ...`):

```python
from app.core.banks import BANKS  # noqa: E402
```

В функции `render_vocabularies` перед финальным `lines.append("")` добавить:

```python
    lines.extend(["", "## Банки", ""])
    for code, name in BANKS.items():
        lines.append(f"- `{code}` — {name}")
```

- [ ] **Step 6: Перегенерировать справочник**

```bash
cd backend && uv run python scripts/gen_reference.py
```

Ожидаемо: в `docs/reference/generated/vocabularies.md` появился раздел «Банки» с тремя строками.

- [ ] **Step 7: Коммит**

```bash
git add backend/app/core/banks.py backend/scripts/gen_reference.py backend/tests/test_bank_accounts.py docs/reference/generated/vocabularies.md
git commit -m "Словарь банков в ядре и в справочнике"
```

---

## Task 2: Миграция и модели

**Files:**
- Create: `backend/alembic/versions/0014_bank_on_account.py`
- Modify: `backend/app/ledger/models.py`
- Test: `backend/tests/test_migrations.py` (сюда в этом проекте пишут проверки схемы — по тесту на миграцию)

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `backend/tests/test_migrations.py`. Импорт `Account` и
`DiscoveredAccount` добавить к существующей строке
`from app.ledger.models import Category, Counterparty, DescriptionRule`:

```python
async def test_migrations_add_bank_columns(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'accounts' "
                "AND column_name IN ('bank_code', 'bank_account_fingerprint')"
            )
        )
        columns = dict(rows.all())
    await engine.dispose()
    # счёт без банка — законное состояние (наличные, банк без плагина), и
    # счета, заведённые до этой миграции, обязаны остаться рабочими
    assert columns == {"bank_code": "YES", "bank_account_fingerprint": "YES"}


async def test_one_bank_account_maps_to_one_app_account(db_session: AsyncSession) -> None:
    """Два счёта приложения на один счёт банка — это разъехавшиеся операции:
    какой из них получит импорт, решал бы порядок, в котором коллектор
    перечислил счета. Проверяем и то, что индекс частичный: счетов без
    отпечатка бывает сколько угодно, и мешать им он не должен."""
    workspace = Workspace(name="Дом", type="personal")
    db_session.add(workspace)
    await db_session.flush()

    def account(name: str, fingerprint: str | None) -> Account:
        return Account(
            workspace_id=workspace.id,
            name=name,
            type="card",
            currency="RUB",
            bank_code="alfa" if fingerprint else None,
            bank_account_fingerprint=fingerprint,
        )

    async with db_session.begin_nested():
        db_session.add_all([account("Наличные", None), account("Кошелёк", None)])
        await db_session.flush()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add_all([account("Первый", "a" * 64), account("Второй", "a" * 64)])
            await db_session.flush()


async def test_fingerprint_without_bank_is_rejected(db_session: AsyncSession) -> None:
    """Отпечаток считается от банка, и без банка не значит ничего: такую строку
    отбивает база, а не только сервис."""
    workspace = Workspace(name="Дом", type="personal")
    db_session.add(workspace)
    await db_session.flush()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                Account(
                    workspace_id=workspace.id,
                    name="Ничей",
                    type="card",
                    currency="RUB",
                    bank_account_fingerprint="b" * 64,
                )
            )
            await db_session.flush()


async def test_discovered_account_is_unique_per_workspace(db_session: AsyncSession) -> None:
    """Повторный сбор не должен плодить строки об одном счёте банка."""
    workspace = Workspace(name="Дом", type="personal")
    db_session.add(workspace)
    await db_session.flush()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            for _ in range(2):
                db_session.add(
                    DiscoveredAccount(
                        workspace_id=workspace.id,
                        bank_code="sber",
                        fingerprint="c" * 64,
                        name="Накопительный",
                        currency="RUB",
                    )
                )
            await db_session.flush()
```

- [ ] **Step 2: Прогнать тесты и увидеть падение**

```bash
cd backend && uv run pytest tests/test_migrations.py -v
```

Ожидаемо: `ImportError: cannot import name 'DiscoveredAccount' from 'app.ledger.models'`.

- [ ] **Step 3: Написать миграцию**

Создать `backend/alembic/versions/0014_bank_on_account.py`:

```python
"""Банк у счёта, отпечаток счёта банка и увиденные счета"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # существующие счета остаются без банка: это законное состояние (наличные,
    # банк без плагина), и поведение задним числом не меняется
    op.add_column("accounts", sa.Column("bank_code", sa.String(20), nullable=True))
    op.add_column(
        "accounts", sa.Column("bank_account_fingerprint", sa.String(64), nullable=True)
    )
    # один счёт банка — один счёт приложения. Частичный индекс: счетов без
    # отпечатка сколько угодно, и NULL уникальности не мешает
    op.create_index(
        "uq_accounts_bank_fingerprint",
        "accounts",
        ["workspace_id", "bank_account_fingerprint"],
        unique=True,
        postgresql_where=sa.text("bank_account_fingerprint IS NOT NULL"),
    )
    op.create_check_constraint(
        op.f("ck_accounts_bank_for_fingerprint"),
        "accounts",
        "bank_account_fingerprint IS NULL OR bank_code IS NOT NULL",
    )

    # счета банка, которых в приложении нет. Отдельная таблица, а не строки в
    # accounts: счёт приложения попал бы в остатки, в дашборд и в выбор счёта
    # при импорте, хотя человек его не заводил
    op.create_table(
        "discovered_accounts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("bank_code", sa.String(20), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        # валюта необязательна: плагин её не всегда распознаёт, и это не повод
        # скрывать счёт от человека
        sa.Column("currency", sa.String(3), nullable=True),
        sa.Column("balance", sa.Numeric(20, 4), nullable=True),
        sa.Column(
            "card_masks", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'")
        ),
        sa.Column(
            "seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_discovered_accounts_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discovered_accounts")),
    )
    op.create_index(
        "uq_discovered_accounts_fingerprint",
        "discovered_accounts",
        ["workspace_id", "fingerprint"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("discovered_accounts")
    op.drop_constraint(op.f("ck_accounts_bank_for_fingerprint"), "accounts", type_="check")
    op.drop_index("uq_accounts_bank_fingerprint", table_name="accounts")
    op.drop_column("accounts", "bank_account_fingerprint")
    op.drop_column("accounts", "bank_code")
```

- [ ] **Step 4: Описать то же в моделях**

В `backend/app/ledger/models.py` в классе `Account` после `card_masks` добавить:

```python
    # банк счёта; пусто — наличные или банк, для которого плагина нет
    bank_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # отпечаток счёта в банке (sha256 от «банк:идентификатор»), считает
    # коллектор. Сырой идентификатор сюда не едет: у Альфы это номер счёта
    bank_account_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
```

В том же классе добавить `__table_args__` (у `Account` их сейчас нет):

```python
    __table_args__ = (
        # Повторяют миграцию 0014 намеренно, по той же причине, что у Category:
        # alembic сравнивает модели с базой, и объяви мы их только в миграции —
        # автогенерация следующей предложила бы их удалить.
        Index(
            "uq_accounts_bank_fingerprint",
            "workspace_id",
            "bank_account_fingerprint",
            unique=True,
            postgresql_where=text("bank_account_fingerprint IS NOT NULL"),
        ),
        CheckConstraint(
            "bank_account_fingerprint IS NULL OR bank_code IS NOT NULL",
            name="bank_for_fingerprint",
        ),
    )
```

Там же, после класса `Account`, добавить модель:

```python
class DiscoveredAccount(Base):
    """Счёт, который банк показал, а в приложении его нет.

    Живёт до привязки: как только человек завёл из него счёт, строка теряет
    смысл — она отвечает ровно на вопрос «что в банке есть, а у нас нет».
    Банковского типа счёта здесь нет намеренно: это слово банка, и в ядро оно
    не едет (см. спеку 2026-09-15, §5.2).
    """

    __tablename__ = "discovered_accounts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    bank_code: Mapped[str] = mapped_column(String(20))
    fingerprint: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    # плагин не всегда распознаёт валюту; счёт от этого не перестаёт
    # существовать и показывается человеку как есть
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    balance: Mapped[Decimal | None] = mapped_column(Numeric(20, 4), nullable=True)
    card_masks: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default=text("'[]'"))
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index(
            "uq_discovered_accounts_fingerprint", "workspace_id", "fingerprint", unique=True
        ),
    )
```

- [ ] **Step 5: Прогнать тесты и увидеть, что они проходят**

```bash
cd backend && uv run pytest tests/test_migrations.py -v
```

Ожидаемо: все тесты файла проходят, включая четыре новых. Тесты поднимают
контейнер Postgres и накатывают миграции — первый прогон дольше обычного.
Схему для них создаёт именно миграция, а модели по ней работают, поэтому
колонка, забытая в миграции, роняет тест, а не тихо появляется из моделей.

- [ ] **Step 6: Перегенерировать схему в справочнике**

```bash
cd backend && uv run python scripts/gen_reference.py
```

Ожидаемо: в `docs/reference/generated/schema.md` появились обе колонки и таблица `discovered_accounts`.

- [ ] **Step 7: Коммит**

```bash
git add backend/alembic/versions/0014_bank_on_account.py backend/app/ledger/models.py backend/tests/test_migrations.py docs/reference/generated/schema.md
git commit -m "Банк и отпечаток у счёта, таблица увиденных счетов"
```

---

## Task 3: Денежный тип на вход — в ядро

Маленькая подготовка: приём денег появляется во втором модуле, и определение должно остаться одним. Сейчас `Money` и запрет float живут в `backend/app/imports/schemas.py`, а `ledger` брать их оттуда не может — модули общаются только через сервисы.

**Files:**
- Modify: `backend/app/core/money.py`
- Modify: `backend/app/imports/schemas.py:65`

- [ ] **Step 1: Перенести тип и проверку в ядро**

В шапке `backend/app/core/money.py` заменить импорт pydantic на:

```python
from pydantic import Field, PlainSerializer
```

В конец того же файла добавить:

```python
# границы совпадают с NUMERIC(20,4) в ledger — иначе переполнение всплывёт
# только на вставке строки, когда запрос уже признан правильным
Money = Annotated[Decimal, Field(max_digits=20, decimal_places=4)]


def reject_float(value: object) -> object:
    """Деньги приходят строкой, и float на входе — уже потерянные разряды.

    Проверка идёт до приведения типа: pydantic молча превратит 1234.5 в
    Decimal, и разница вылезет не здесь, а в сведении остатков.
    """
    if isinstance(value, float):
        raise ValueError("сумма должна быть строкой, а не числом JSON")
    return value
```

- [ ] **Step 2: Убрать копию из imports**

В `backend/app/imports/schemas.py` удалить определение `Money` вместе с его комментарием и импортировать из ядра:

```python
from app.core.money import Money, reject_float
```

Тело `ParsedAccountIn._balance_not_float` заменить на вызов общей проверки:

```python
    @field_validator("balance", mode="before")
    @classmethod
    def _balance_not_float(cls, value: object) -> object:
        return reject_float(value)
```

- [ ] **Step 3: Прогнать тесты импорта — поведение не должно измениться**

```bash
cd backend && uv run pytest tests/test_imports_parsed.py -v
```

Ожидаемо: все проходят, включая проверку про float в остатке.

- [ ] **Step 4: Коммит**

```bash
git add backend/app/core/money.py backend/app/imports/schemas.py
git commit -m "Денежный тип на вход и запрет float — в ядро: их принимает уже два модуля"
```

---

## Task 4: Приём счетов банка от коллектора

**Files:**
- Modify: `backend/app/ledger/schemas.py`, `repository.py`, `service.py`, `router.py`
- Test: `backend/tests/test_bank_accounts.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `backend/tests/test_bank_accounts.py`:

```python
from typing import Any

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _workspace(client: AsyncClient, user: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=user)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


def _seen(fingerprint: str, name: str, **extra: Any) -> dict[str, Any]:
    return {"fingerprint": fingerprint, "name": name, "currency": "RUB", **extra}


async def _sync(client: AsyncClient, ws: str, bank: str, accounts: list[dict[str, Any]]) -> Any:
    return await client.put(
        "/api/accounts/discovered",
        params={"workspace_id": ws, "bank": bank},
        json={"accounts": accounts},
    )


async def test_seen_accounts_become_visible(client: AsyncClient) -> None:
    """Коллектор сообщает, что показал банк: без этого человеку не из чего
    заводить счёт, а коллектору некуда слать импорт."""
    ws = await _workspace(client, ALICE)
    resp = await _sync(
        client,
        ws,
        "alfa",
        [
            _seen("a" * 64, "Текущий счёт", balance="1000.00", card_masks=["1234"]),
            _seen("b" * 64, "Накопительный"),
        ],
    )
    assert resp.status_code == 200
    assert resp.json()["linked"] == {}

    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json()
    assert [row["name"] for row in rows] == ["Накопительный", "Текущий счёт"]
    assert rows[1]["card_masks"] == ["1234"]
    assert rows[1]["bank_code"] == "alfa"
    # название банка приходит с бэкенда: своего списка банков фронт не держит
    assert rows[1]["bank_name"] == "Альфа-Банк"


async def test_closed_account_stops_being_seen(client: AsyncClient) -> None:
    """Список заменяется целиком: счёт, которого в банке больше нет, не остаётся
    висеть предложением «завести»."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий"), _seen("b" * 64, "Старый")])
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий")])

    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json()
    assert [row["name"] for row in rows] == ["Текущий"]


async def test_other_bank_accounts_survive_sync(client: AsyncClient) -> None:
    """Сбор по одному банку не стирает увиденное у другого: банки собираются
    по очереди, разными запусками."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Альфа-счёт")])
    await _sync(client, ws, "sber", [_seen("b" * 64, "Сбер-счёт")])

    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json()
    assert {row["name"] for row in rows} == {"Альфа-счёт", "Сбер-счёт"}


async def test_unknown_bank_is_rejected(client: AsyncClient) -> None:
    """Код банка — единственное, чем приложение и коллектор узнают один банк.
    Незнакомый обязан быть виден отказом, а не записаться строкой."""
    ws = await _workspace(client, ALICE)
    assert (await _sync(client, ws, "vtb", [_seen("a" * 64, "Счёт")])).status_code == 422


async def test_malformed_fingerprint_is_rejected(client: AsyncClient) -> None:
    """Отпечаток — ровно sha256 в hex. Другое означает баг коллектора, и принять
    его значит развести мусор в привязках."""
    ws = await _workspace(client, ALICE)
    assert (await _sync(client, ws, "alfa", [_seen("A" * 64, "Счёт")])).status_code == 422
    assert (await _sync(client, ws, "alfa", [_seen("a" * 63, "Счёт")])).status_code == 422


async def test_balance_as_json_number_is_rejected(client: AsyncClient) -> None:
    """Остаток float'ом — потерянные разряды ещё до валидации; коллектор шлёт
    деньги строкой, и нарушение этого должно быть видно."""
    ws = await _workspace(client, ALICE)
    resp = await _sync(client, ws, "alfa", [_seen("a" * 64, "Счёт", balance=1000.5)])
    assert resp.status_code == 422


async def test_seen_accounts_are_isolated_by_workspace(client: AsyncClient) -> None:
    """Утечка между workspace — критический баг, и увиденные счета не исключение:
    имя счёта и хвост карты говорят о человеке достаточно."""
    alice_ws = await _workspace(client, ALICE)
    await _sync(client, alice_ws, "alfa", [_seen("a" * 64, "Текущий")])
    await client.post("/api/auth/logout")

    bob_ws = await _workspace(client, BOB)
    assert (await client.get("/api/accounts/discovered", params={"workspace_id": bob_ws})).json() == []

    forbidden = await client.get("/api/accounts/discovered", params={"workspace_id": alice_ws})
    assert forbidden.status_code == 403
```

Ручки здесь существующие: `POST /api/auth/logout` (`backend/app/identity/router.py:81`), а 403 на чужой workspace даёт `require_workspace_member` (`backend/app/identity/deps.py:94`).

- [ ] **Step 2: Прогнать тесты и увидеть падение**

```bash
cd backend && uv run pytest tests/test_bank_accounts.py -v
```

Ожидаемо: новые падают — ручки `/api/accounts/discovered` нет (405 или 404).

- [ ] **Step 3: Добавить схемы**

В шапку `backend/app/ledger/schemas.py` добавить `import re`, расширить импорт pydantic до `from pydantic import BaseModel, Field, field_serializer, field_validator` и добавить:

```python
from app.core.banks import BANK_CODE_PATTERN
from app.core.money import Money, MoneyStr, reject_float
```

После `AccountOut` добавить:

```python
# столько счетов не бывает ни у одного банка: ограничение отбивает пачку,
# которая заведомо не про счета
MAX_DISCOVERED_ACCOUNTS = 100
FINGERPRINT = r"^[0-9a-f]{64}$"
CARD_MASK = r"^[0-9]{4}$"
MAX_CARD_MASKS = 10


class DiscoveredAccountIn(BaseModel):
    """Счёт, который банк показал коллектору.

    Банковского типа счёта здесь нет: это слово банка, и в ядро оно не едет
    (спека 2026-09-15, §5.2). Тип своего счёта человек выбирает при заведении.
    """

    fingerprint: str = Field(pattern=FINGERPRINT)
    name: str = Field(max_length=200)
    # плагин не всегда распознаёт валюту, и это не повод скрывать счёт
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    balance: Money | None = None
    card_masks: list[str] = Field(default_factory=list, max_length=MAX_CARD_MASKS)

    @field_validator("balance", mode="before")
    @classmethod
    def _balance_not_float(cls, value: object) -> object:
        return reject_float(value)

    @field_validator("card_masks")
    @classmethod
    def _masks_are_four_digits(cls, value: list[str]) -> list[str]:
        for mask in value:
            # хранить кусок номера карты сверх последних четырёх цифр мы не
            # собираемся, а укороченная метка счёт не опознаёт
            if not re.fullmatch(CARD_MASK, mask):
                raise ValueError("метка карты — ровно четыре цифры")
        return value


class DiscoveredSyncIn(BaseModel):
    accounts: list[DiscoveredAccountIn] = Field(max_length=MAX_DISCOVERED_ACCOUNTS)


class DiscoveredSyncOut(BaseModel):
    # отпечаток → счёт приложения: по нему коллектор понимает, куда слать импорт
    linked: dict[str, uuid.UUID]


class DiscoveredAccountOut(BaseModel):
    fingerprint: str
    bank_code: str
    # название банка отдаёт бэкенд: словарь живёт в одном месте
    bank_name: str
    name: str
    currency: str | None
    balance: MoneyStr | None
    card_masks: list[str]
```

- [ ] **Step 4: Добавить работу с базой**

В `backend/app/ledger/repository.py` дописать `delete` в импорт из `sqlalchemy`, `DiscoveredAccount` — в импорт из `app.ledger.models`, и добавить после `add_account`:

```python
async def linked_bank_accounts(
    db: AsyncSession, workspace_id: uuid.UUID, bank_code: str
) -> dict[str, uuid.UUID]:
    """Привязанные счета банка: отпечаток → счёт приложения."""
    stmt = select(Account.bank_account_fingerprint, Account.id).where(
        Account.workspace_id == workspace_id,
        Account.bank_code == bank_code,
        Account.bank_account_fingerprint.is_not(None),
    )
    rows = await db.execute(stmt)
    return {fingerprint: account_id for fingerprint, account_id in rows.all()}


async def replace_discovered(
    db: AsyncSession, workspace_id: uuid.UUID, bank_code: str, rows: list[DiscoveredAccount]
) -> None:
    """Увиденное у этого банка заменяется целиком.

    Замена, а не досыпание: иначе счёт, закрытый в банке, остался бы висеть
    предложением завести его, и убрать его было бы нечем.
    """
    await db.execute(
        delete(DiscoveredAccount).where(
            DiscoveredAccount.workspace_id == workspace_id,
            DiscoveredAccount.bank_code == bank_code,
        )
    )
    db.add_all(rows)


async def list_discovered(db: AsyncSession, workspace_id: uuid.UUID) -> list[DiscoveredAccount]:
    stmt = (
        select(DiscoveredAccount)
        .where(DiscoveredAccount.workspace_id == workspace_id)
        .order_by(DiscoveredAccount.bank_code, DiscoveredAccount.name)
    )
    return list(await db.scalars(stmt))


async def get_discovered(
    db: AsyncSession, workspace_id: uuid.UUID, bank_code: str, fingerprint: str
) -> DiscoveredAccount | None:
    row: DiscoveredAccount | None = await db.scalar(
        select(DiscoveredAccount).where(
            DiscoveredAccount.workspace_id == workspace_id,
            DiscoveredAccount.bank_code == bank_code,
            DiscoveredAccount.fingerprint == fingerprint,
        )
    )
    return row
```

`get_discovered` понадобится в Task 6 — пишем сразу, чтобы не возвращаться в файл дважды.

- [ ] **Step 5: Добавить сервис**

В `backend/app/ledger/service.py` дописать `DiscoveredAccount` в импорт моделей, `DiscoveredAccountIn` — в импорт схем, и добавить после `apply_reported_balance`:

```python
async def sync_discovered(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    bank_code: str,
    seen: list[DiscoveredAccountIn],
) -> dict[str, uuid.UUID]:
    """Запомнить, какие счета показал банк, и ответить привязками.

    Привязанные в «увиденные» не попадают: этот список отвечает ровно на один
    вопрос — что в банке есть, а в приложении нет.
    """
    linked = await repository.linked_bank_accounts(db, workspace_id, bank_code)
    await repository.replace_discovered(
        db,
        workspace_id,
        bank_code,
        [
            DiscoveredAccount(
                workspace_id=workspace_id,
                bank_code=bank_code,
                fingerprint=item.fingerprint,
                name=item.name,
                currency=item.currency,
                balance=item.balance,
                card_masks=item.card_masks,
            )
            for item in seen
            if item.fingerprint not in linked
        ],
    )
    await db.commit()
    # счёт, привязанный когда-то, но исчезнувший из банка, коллектору не
    # отдаём: собирать по нему нечего, а запрос за его операциями закончился бы
    # ошибкой банка посреди сбора
    shown = {item.fingerprint for item in seen}
    return {fp: account_id for fp, account_id in linked.items() if fp in shown}


async def list_discovered(db: AsyncSession, workspace_id: uuid.UUID) -> list[DiscoveredAccount]:
    return await repository.list_discovered(db, workspace_id)
```

- [ ] **Step 6: Добавить ручки**

В `backend/app/ledger/router.py` дописать импорты:

```python
from app.core.banks import BANK_CODE_PATTERN, BANKS
from app.ledger.models import DiscoveredAccount
from app.ledger.schemas import DiscoveredAccountOut, DiscoveredSyncIn, DiscoveredSyncOut
```

(`DiscoveredAccount` добавить в существующий импорт из `app.ledger.models`, схемы — в существующий импорт из `app.ledger.schemas`.)

Добавить сразу после `list_accounts`:

```python
def _discovered_out(row: DiscoveredAccount) -> DiscoveredAccountOut:
    return DiscoveredAccountOut(
        fingerprint=row.fingerprint,
        bank_code=row.bank_code,
        bank_name=BANKS[row.bank_code],
        name=row.name,
        currency=row.currency,
        balance=row.balance,
        card_masks=row.card_masks,
    )


@router.put("/accounts/discovered")
async def sync_discovered_accounts(
    payload: DiscoveredSyncIn,
    workspace_id: uuid.UUID,
    bank: Annotated[str, Query(pattern=BANK_CODE_PATTERN)],
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> DiscoveredSyncOut:
    linked = await service.sync_discovered(db, workspace_id, bank, payload.accounts)
    return DiscoveredSyncOut(linked=linked)


@router.get("/accounts/discovered")
async def list_discovered_accounts(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[DiscoveredAccountOut]:
    return [_discovered_out(row) for row in await service.list_discovered(db, workspace_id)]
```

- [ ] **Step 7: Прогнать тесты и увидеть, что они проходят**

```bash
cd backend && uv run pytest tests/test_bank_accounts.py -v
```

Ожидаемо: все проходят.

- [ ] **Step 8: Линт и типы**

```bash
cd backend && uv run ruff format . && uv run ruff check . && uv run mypy app
```

Ожидаемо: без замечаний.

- [ ] **Step 9: Коммит**

```bash
git add backend/app/ledger backend/tests/test_bank_accounts.py
git commit -m "Коллектор сообщает счета банка, приложение отвечает привязками"
```

---

## Task 5: Заведение счёта из увиденного и банк в ответе счёта

**Files:**
- Modify: `backend/app/ledger/schemas.py`, `service.py`, `router.py`
- Test: `backend/tests/test_bank_accounts.py`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `backend/tests/test_bank_accounts.py`:

```python
async def test_account_created_from_seen_one_gets_bank(client: AsyncClient) -> None:
    """Ради этого всё и делается: счёт заводится из показанного банком и
    перестаёт быть безымянной строкой в env коллектора."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])

    created = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Альфа карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "alfa",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert created.status_code == 201
    assert created.json()["bank_code"] == "alfa"

    # счёт заведён — предлагать завести его второй раз больше нечего
    assert (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json() == []

    # а коллектор со следующего сбора знает, куда слать импорт
    linked = (await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])).json()["linked"]
    assert linked == {"a" * 64: created.json()["id"]}


async def test_links_do_not_leak_between_workspaces(client: AsyncClient) -> None:
    """Привязка — это ответ на вопрос «куда слать операции». Утёкшая в чужой
    workspace, она отправила бы чужие операции на чужой счёт.

    Тест заведён отдельно потому, что при исполнении Task 4 выяснилось: фильтр
    по workspace в linked_bank_accounts не стерёг ни один тест — непустых
    привязок в проверках не было вовсе.
    """
    alice_ws = await _workspace(client, ALICE)
    await _sync(client, alice_ws, "alfa", [_seen("a" * 64, "Текущий счёт")])
    created = await client.post(
        "/api/accounts",
        params={"workspace_id": alice_ws},
        json={
            "name": "Альфа карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "alfa",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert created.status_code == 201
    await client.post("/api/auth/logout")

    bob_ws = await _workspace(client, BOB)
    # тот же счёт банка у другого человека: отпечаток совпадает, привязка — нет
    linked = (await _sync(client, bob_ws, "alfa", [_seen("a" * 64, "Текущий счёт")])).json()
    assert linked["linked"] == {}


async def test_linked_account_gone_from_bank_is_not_returned(client: AsyncClient) -> None:
    """Счёт закрыли в банке, а в приложении он остался привязанным. Отдать его
    коллектору значит послать его за операциями несуществующего счёта — банк
    ответит ошибкой, и сбор встанет посреди работы."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])
    await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Альфа карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "alfa",
            "bank_account_fingerprint": "a" * 64,
        },
    )

    linked = (await _sync(client, ws, "alfa", [])).json()["linked"]
    assert linked == {}


async def test_second_account_on_same_bank_account_is_refused(client: AsyncClient) -> None:
    """Два счёта приложения на один счёт банка развели бы операции по двум
    местам. Первое заведение убирает счёт из увиденных, второе получает отказ."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])
    body = {
        "name": "Альфа карта",
        "type": "card",
        "currency": "RUB",
        "bank_code": "alfa",
        "bank_account_fingerprint": "a" * 64,
    }
    assert (await client.post("/api/accounts", params={"workspace_id": ws}, json=body)).status_code == 201

    again = await client.post("/api/accounts", params={"workspace_id": ws}, json=body)
    assert again.status_code == 404


async def test_fingerprint_from_another_bank_is_refused(client: AsyncClient) -> None:
    """Отпечаток считается от банка: тот же отпечаток под чужим банком — это
    не тот счёт, и привязать его нельзя."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])

    resp = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Сбер карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "sber",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert resp.status_code == 404


async def test_fingerprint_without_bank_is_refused(client: AsyncClient) -> None:
    ws = await _workspace(client, ALICE)
    resp = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Ничей",
            "type": "card",
            "currency": "RUB",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert resp.status_code == 422


async def test_manual_account_may_name_its_bank(client: AsyncClient) -> None:
    """Счёт в банке без плагина ведётся руками, но в списке обязан стоять
    рядом со своими: банк задаётся без всякого отпечатка."""
    ws = await _workspace(client, ALICE)
    created = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": "Сбер вклад", "type": "savings", "currency": "RUB", "bank_code": "sber"},
    )
    assert created.status_code == 201
    assert created.json()["bank_code"] == "sber"


async def test_account_without_bank_still_works(client: AsyncClient) -> None:
    """Наличные банка не имеют, и заведение счёта не должно этого требовать."""
    ws = await _workspace(client, ALICE)
    created = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": "Кошелёк", "type": "cash", "currency": "RUB"},
    )
    assert created.status_code == 201
    assert created.json()["bank_code"] is None


async def test_banks_dictionary_is_served(client: AsyncClient) -> None:
    """Названия банков живут в одном месте — в ядре; фронт берёт их отсюда."""
    await _workspace(client, ALICE)
    resp = await client.get("/api/banks")
    assert resp.status_code == 200
    assert {"code": "alfa", "name": "Альфа-Банк"} in resp.json()
```

- [ ] **Step 2: Прогнать тесты и увидеть падение**

```bash
cd backend && uv run pytest tests/test_bank_accounts.py -v
```

Ожидаемо: новые падают — `bank_code` в ответе нет, `/api/banks` нет.

- [ ] **Step 3: Расширить схемы**

В `backend/app/ledger/schemas.py` дописать в `AccountCreate`:

```python
    # банк необязателен: у наличных его нет. Отпечаток — только вместе с банком
    # и только для счёта, который банк уже показал (см. service.create_account)
    bank_code: str | None = Field(default=None, pattern=BANK_CODE_PATTERN)
    bank_account_fingerprint: str | None = Field(default=None, pattern=FINGERPRINT)

    @model_validator(mode="after")
    def _fingerprint_needs_bank(self) -> "AccountCreate":
        if self.bank_account_fingerprint is not None and self.bank_code is None:
            # отпечаток считается от банка и без него не значит ничего
            raise ValueError("отпечаток счёта банка без кода банка")
        return self
```

Импорт pydantic расширить до `from pydantic import BaseModel, Field, field_serializer, field_validator, model_validator`.

Константы `FINGERPRINT` и `MAX_DISCOVERED_ACCOUNTS` объявлены в Task 4 выше `AccountCreate` — если они оказались ниже по файлу, поднять блок констант над классами.

В `AccountOut` дописать:

```python
    # банк счёта; null — наличные или банк без плагина
    bank_code: str | None
```

И добавить схему словаря:

```python
class BankOut(BaseModel):
    code: str
    name: str
```

- [ ] **Step 4: Привязка в сервисе**

В `backend/app/ledger/service.py` добавить исключение рядом с `NotFoundError`:

```python
class DiscoveredNotFoundError(Exception):
    """Счёт банка, от которого заводят счёт, не числится увиденным."""
```

И переписать `create_account`:

```python
async def create_account(
    db: AsyncSession, workspace_id: uuid.UUID, payload: AccountCreate
) -> tuple[Account, Decimal]:
    discovered = None
    if payload.bank_account_fingerprint is not None:
        # заводим только от того, что банк действительно показал: иначе в
        # привязках появились бы отпечатки, которым ничего не соответствует,
        # и коллектор молча собирал бы в никуда
        assert payload.bank_code is not None  # обеспечено схемой AccountCreate
        discovered = await repository.get_discovered(
            db, workspace_id, payload.bank_code, payload.bank_account_fingerprint
        )
        if discovered is None:
            raise DiscoveredNotFoundError
    account = Account(
        workspace_id=workspace_id,
        name=payload.name,
        type=payload.type,
        currency=payload.currency,
        bank_code=payload.bank_code,
        bank_account_fingerprint=payload.bank_account_fingerprint,
    )
    repository.add_account(db, account)
    if discovered is not None:
        # строка отвечала на вопрос «что в банке есть, а у нас нет»; ответ
        # изменился, и держать её значит предлагать завести счёт дважды
        await db.delete(discovered)
    await db.commit()
    return account, Decimal(0)
```

`assert` здесь — не проверка ввода, а утверждение о том, что схема уже отбила невозможный случай; ввод проверяет `_fingerprint_needs_bank`.

- [ ] **Step 5: Ручки**

В `backend/app/ledger/router.py` в `_account_out` дописать `bank_code=account.bank_code`.

В `create_account` обработать новый отказ:

```python
@router.post("/accounts", status_code=201)
async def create_account(
    payload: AccountCreate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AccountOut:
    try:
        account, balance = await service.create_account(db, workspace_id, payload)
    except service.DiscoveredNotFoundError:
        raise HTTPException(
            status_code=404, detail="Счёт банка не найден среди увиденных"
        ) from None
    return _account_out(account, balance)
```

И добавить словарь банков рядом с остальными ручками:

```python
@router.get("/banks")
async def list_banks(
    _user: Annotated[User, Depends(get_current_user)],
) -> list[BankOut]:
    """Словарь банков: код и человеческое название. Фронт своего списка не
    держит — разъехались бы."""
    return [BankOut(code=code, name=name) for code, name in BANKS.items()]
```

`get_current_user` — существующая зависимость (`backend/app/identity/deps.py:25`), ею же пользуется `GET /api/me` (`backend/app/identity/router.py:95`). Workspace здесь ни при чём: словарь банков один на всё приложение и ничьих данных не содержит. В импорты роутера добавить `from app.identity.deps import get_current_user` (там уже импортируется `require_workspace_member`) и `BankOut` — в импорт схем.

- [ ] **Step 6: Прогнать тесты**

```bash
cd backend && uv run pytest tests/test_bank_accounts.py tests/test_account_balance.py -v
```

Ожидаемо: проходят и новые, и старые тесты счетов — `AccountOut` вырос, но ничего не потерял.

- [ ] **Step 7: Линт, типы и весь бэкенд**

```bash
cd backend && uv run ruff format . && uv run ruff check . && uv run mypy app && uv run pytest
```

Ожидаемо: зелено. Здесь же выяснится, не сломал ли новый обязательный ключ `bank_code` в `AccountOut` чей-нибудь тест.

- [ ] **Step 8: Перегенерировать справочник API**

```bash
cd backend && uv run python scripts/gen_reference.py
```

- [ ] **Step 9: Коммит**

```bash
git add backend docs/reference/generated
git commit -m "Счёт заводится из показанного банком и знает свой банк"
```

---

## Task 6: Отпечаток счёта в коллекторе

**Files:**
- Create: `collector/src/runner/fingerprint.ts`
- Test: `collector/src/runner/fingerprint.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `collector/src/runner/fingerprint.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { accountFingerprint } from './fingerprint'

test('отпечаток одного счёта не меняется между запусками', () => {
  // на этом держится вся привязка: другой отпечаток — другой счёт, и импорт
  // уехал бы не туда
  expect(accountFingerprint('alfa', '40817810099910004312')).toBe(
    accountFingerprint('alfa', '40817810099910004312'),
  )
})

test('одинаковые идентификаторы в разных банках дают разные отпечатки', () => {
  // у Сбербанка идентификатор — card:<id>, у Альфы — номер счёта; совпадение
  // форматов ничем не запрещено, и банк обязан входить в отпечаток
  expect(accountFingerprint('sber', '12345')).not.toBe(accountFingerprint('alfa', '12345'))
})

test('отпечаток — sha256 в нижнем регистре: приложение принимает только такой', () => {
  expect(accountFingerprint('tbank', 'acc-1')).toMatch(/^[0-9a-f]{64}$/)
})

test('сырой идентификатор в отпечатке не виден', () => {
  // ради этого отпечаток и заведён: у Альфы идентификатор — номер счёта,
  // то есть реквизит для перевода
  const number = '40817810099910004312'
  expect(accountFingerprint('alfa', number)).not.toContain(number)
})
```

- [ ] **Step 2: Прогнать тест и увидеть падение**

```bash
cd collector && pnpm vitest run src/runner/fingerprint.test.ts
```

Ожидаемо: `Failed to resolve import "./fingerprint"`.

- [ ] **Step 3: Написать отпечаток**

Создать `collector/src/runner/fingerprint.ts`:

```typescript
import { createHash } from 'node:crypto'

/**
 * Отпечаток счёта банка: sha256 от «банк:идентификатор».
 *
 * Считается здесь, а не в приложении, намеренно: идентификатор счёта у банков
 * разной природы, и у Альфы это номер счёта — реквизит, по которому на счёт
 * переводят деньги. В базу приложения он не едет, а для привязки довольно
 * равенства. Банк входит в отпечаток, потому что одинаковый идентификатор в
 * двух банках ничего общего не означает.
 */
export function accountFingerprint(bank: string, accountId: string): string {
  return createHash('sha256').update(`${bank}:${accountId}`).digest('hex')
}
```

- [ ] **Step 4: Прогнать тест и увидеть, что он проходит**

```bash
cd collector && pnpm vitest run src/runner/fingerprint.test.ts
```

Ожидаемо: 4 passed.

- [ ] **Step 5: Коммит**

```bash
git add collector/src/runner/fingerprint.ts collector/src/runner/fingerprint.test.ts
git commit -m "Отпечаток счёта банка: сырой идентификатор машину владельца не покидает"
```

---

## Task 7: Клиент ручки привязок

**Files:**
- Create: `collector/src/runner/discovered.ts`
- Test: `collector/src/runner/discovered.test.ts`

Образец для стиля и разбора отказа — `collector/src/runner/push.ts` и `push.test.ts`.

- [ ] **Step 1: Написать падающий тест**

Создать `collector/src/runner/discovered.test.ts`:

```typescript
import { expect, test, vi } from 'vitest'
import type { CollectedAccount } from '../core/contract'
import type { CollectorConfig } from './config'
import { syncDiscovered } from './discovered'

const config = {
  apiBaseUrl: 'http://localhost:8000',
  apiToken: 'token',
  workspaceId: 'ws-1',
  days: 30,
  bank: 'alfa',
} as CollectorConfig

function account(id: string, extra: Partial<CollectedAccount> = {}): CollectedAccount {
  return {
    id,
    name: 'Текущий счёт',
    type: 'CURRENT',
    currency: 'RUB',
    balance: '1000.00',
    cardMasks: ['1234'],
    ...extra,
  }
}

function ok(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

test('в приложение уезжает отпечаток, а не идентификатор счёта', async () => {
  const fetchImpl = ok({ linked: {} })
  await syncDiscovered(config, 'alfa', [account('40817810099910004312')], fetchImpl)

  const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
  const body = JSON.parse(String(init?.body))
  expect(body.accounts[0].fingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(body)).not.toContain('40817810099910004312')
})

test('банковский тип счёта в приложение не отправляется', async () => {
  // CollectedAccount.type — слово банка ('GK' у Альфы, accountType у Т-Банка);
  // словарь банка в ядро не едет
  const fetchImpl = ok({ linked: {} })
  await syncDiscovered(config, 'alfa', [account('acc-1')], fetchImpl)

  const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
  expect(JSON.parse(String(init?.body)).accounts[0]).not.toHaveProperty('type')
})

test('привязки возвращаются по идентификатору счёта банка, а не по отпечатку', async () => {
  // дальше по коду ими адресуют fetchOperations, которому нужен id банка
  const { accountFingerprint } = await import('./fingerprint')
  const fingerprint = accountFingerprint('alfa', 'acc-1')
  const linked = await syncDiscovered(
    config,
    'alfa',
    [account('acc-1'), account('acc-2')],
    ok({ linked: { [fingerprint]: 'app-1' } }),
  )
  expect(linked.get('acc-1')).toBe('app-1')
  expect(linked.has('acc-2')).toBe(false)
})

test('отказ приложения останавливает сбор понятной ошибкой', async () => {
  const fetchImpl = vi.fn(async () => new Response('{"detail":"нет доступа"}', { status: 403 }))
  await expect(
    syncDiscovered(config, 'alfa', [account('acc-1')], fetchImpl as unknown as typeof fetch),
  ).rejects.toThrow(/403/)
})

test('неожиданный ответ не проходит молча', async () => {
  await expect(
    syncDiscovered(config, 'alfa', [account('acc-1')], ok({ что: 'то' })),
  ).rejects.toThrow(/неожиданный ответ/i)
})
```

- [ ] **Step 2: Прогнать тест и увидеть падение**

```bash
cd collector && pnpm vitest run src/runner/discovered.test.ts
```

Ожидаемо: `Failed to resolve import "./discovered"`.

- [ ] **Step 3: Написать клиент**

Создать `collector/src/runner/discovered.ts`:

```typescript
import type { CollectedAccount } from '../core/contract'
import type { FetchImpl } from '../http/allowlist-client'
import type { CollectorConfig } from './config'
import { accountFingerprint } from './fingerprint'

/**
 * Сообщить приложению, какие счета показал банк, и узнать, какие из них
 * привязаны к счетам приложения.
 *
 * Возвращает соответствие «идентификатор счёта банка → счёт приложения»:
 * отпечаток нужен только на проводе, а дальше по коду счета адресуются так,
 * как их называет банк — этим же значением работает fetchOperations.
 *
 * Тип счёта не отправляется: CollectedAccount.type — слово банка, и в ядро
 * приложения оно не едет.
 */
export async function syncDiscovered(
  config: CollectorConfig,
  bank: string,
  accounts: readonly CollectedAccount[],
  fetchImpl: FetchImpl = fetch,
): Promise<Map<string, string>> {
  const byFingerprint = new Map<string, string>()
  const payload = accounts.map((account) => {
    const fingerprint = accountFingerprint(bank, account.id)
    byFingerprint.set(fingerprint, account.id)
    return {
      fingerprint,
      name: account.name,
      currency: account.currency,
      balance: account.balance,
      card_masks: account.cardMasks,
    }
  })

  const url = new URL('/api/accounts/discovered', config.apiBaseUrl)
  url.searchParams.set('workspace_id', config.workspaceId)
  url.searchParams.set('bank', bank)

  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ accounts: payload }),
  })
  if (!res.ok) throw new Error(`Приложение ответило ${res.status} на список счетов`)

  const linked = new Map<string, string>()
  for (const [fingerprint, appAccountId] of Object.entries(parseLinked(await res.json()))) {
    const bankAccountId = byFingerprint.get(fingerprint)
    // отпечаток, которого мы не посылали, адресовать нечем — молча пропускаем
    // такую пару, а не гадаем, чей это счёт
    if (bankAccountId) linked.set(bankAccountId, appAccountId)
  }
  return linked
}

function parseLinked(data: unknown): Record<string, string> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Приложение вернуло неожиданный ответ на список счетов')
  }
  const linked = (data as Record<string, unknown>)['linked']
  if (typeof linked !== 'object' || linked === null || Array.isArray(linked)) {
    throw new Error('Приложение вернуло неожиданный ответ на список счетов')
  }
  const result: Record<string, string> = {}
  for (const [fingerprint, appAccountId] of Object.entries(linked)) {
    if (typeof appAccountId !== 'string') {
      throw new Error('Приложение вернуло неожиданный ответ на список счетов')
    }
    result[fingerprint] = appAccountId
  }
  return result
}
```

- [ ] **Step 4: Прогнать тест и увидеть, что он проходит**

```bash
cd collector && pnpm vitest run src/runner/discovered.test.ts
```

Ожидаемо: 5 passed.

- [ ] **Step 5: Коммит**

```bash
git add collector/src/runner/discovered.ts collector/src/runner/discovered.test.ts
git commit -m "Коллектор спрашивает приложение, какие счета банка привязаны"
```

---

## Task 8: Коллектор перестаёт читать AICCOUNTANT_ACCOUNTS

**Files:**
- Modify: `collector/src/runner/main.ts`
- Modify: `collector/src/runner/config.ts`
- Modify: `collector/src/runner/config.test.ts`
- Modify: `collector/README.md`

- [ ] **Step 1: Убрать из конфига переменную и её разбор**

В `collector/src/runner/config.ts`:

- удалить поле `accountMap` из `CollectorConfig` вместе с комментарием;
- удалить строку `accountMap: parseAccountMap(accountsRaw(env, bank)),` из `loadConfig`;
- удалить функции `accountsRaw` и `parseAccountMap` целиком.

- [ ] **Step 2: Убрать её же из тестов конфига**

В `collector/src/runner/config.test.ts` удалить тесты, проверяющие
`AICCOUNTANT_ACCOUNTS`: разбор соответствия, битый JSON, массив вместо объекта,
нестроковое значение, пустой идентификатор и пер-банковскую переменную. Это не
потеря покрытия: проверяемого кода больше нет.

- [ ] **Step 3: Прогнать тесты конфига**

```bash
cd collector && pnpm vitest run src/runner/config.test.ts
```

Ожидаемо: оставшиеся тесты проходят, ни один не падает на отсутствующем `accountMap`.

- [ ] **Step 4: Переписать порядок сбора**

В `collector/src/runner/main.ts` заменить `main` и `collect`, удалить
`printAccountsHint` и `assertAccountsExist`, добавить импорт
`import { syncDiscovered } from './discovered'`:

```typescript
async function main(): Promise<void> {
  const config = loadConfig()
  // сертификат добывается лениво: банку, чей УЦ известен системе, он не нужен,
  // и падать из-за недоступности точки раздачи сертификата такой сбор не должен.
  // Побочно это же и определяет, надо ли закреплять ключ УЦ в окне входа: пин
  // получает ровно тот банк, который попросил корень, — без списка банков в
  // оболочке и без расширения доверия там, где оно не нужно
  let pinnedSpki: string | undefined
  const plugin = await pluginFor(config.bank, {
    loadCa: async () => {
      pinnedSpki = ROOT_SPKI_SHA256
      return loadTrustAnchor(CA_CACHE)
    },
  })
  const store = osSecretStore()

  const credentials = await connect(plugin, store, pinnedSpki)
  const accounts = await plugin.fetchAccounts(credentials)
  // какие счета вести, решает человек в приложении: здесь мы только
  // рассказываем, что показал банк, и спрашиваем, куда слать импорты
  const linked = await syncDiscovered(config, plugin.name, accounts)

  if (linked.size === 0) {
    console.log('Ни один счёт банка не привязан к счёту приложения.')
    console.log('Заведите нужные счета на экране «Счета» и запустите сбор снова.')
    return
  }
  await collect(config, plugin, credentials, accounts, linked)
  console.log('Готово. Подтвердите импорт в приложении.')
}
```

```typescript
async function collect(
  config: CollectorConfig,
  plugin: BankPlugin,
  credentials: Credentials,
  accounts: readonly CollectedAccount[],
  linked: ReadonlyMap<string, string>,
): Promise<void> {
  const until = Date.now()
  const since = until - config.days * DAY_MS

  for (const account of accounts) {
    const appAccountId = linked.get(account.id)
    // счёт банка, который человек не завёл: не ошибка, а обычное дело —
    // из двенадцати счетов в приложении ведётся часть
    if (!appAccountId) continue
    const operations = await plugin.fetchOperations(credentials, account.id, since, until)
    const result = await pushOperations(config, plugin.name, appAccountId, operations, account)
    // в консоль только идентификаторы и счётчики: ни сумм, ни описаний
    console.log(
      result
        ? `счёт ${appAccountId}: собрано ${operations.length}, импорт ${result.import_id}`
        : `счёт ${appAccountId}: операций за период нет`,
    )
    // счётчики живут в общем report.ts: они одинаковы для всех банков, и
    // вторая копия разошлась бы с первой
    reportCollected(appAccountId, operations)
  }
}
```

- [ ] **Step 5: Прогнать все тесты коллектора, линт и типы**

```bash
cd collector && pnpm test && pnpm lint && pnpm build
```

Ожидаемо: зелено. Если что-то ещё ссылается на `config.accountMap`, здесь это и выяснится.

- [ ] **Step 6: Поправить README коллектора**

В `collector/README.md` заменить раздел про `AICCOUNTANT_ACCOUNTS` описанием нового порядка: коллектор сам сообщает приложению счета банка, а какие из них вести — человек отмечает на экране «Счета». Переменную из таблицы переменных убрать. Упоминания `AICCOUNTANT_ACCOUNTS` в файле не должно остаться:

```bash
grep -rn "AICCOUNTANT_ACCOUNTS" collector/ docs/ || echo "упоминаний нет"
```

- [ ] **Step 7: Коммит**

```bash
git add collector
git commit -m "Привязка счетов переезжает из переменной окружения в приложение"
```

---

## Task 9: Группировка счетов по банку

**Files:**
- Modify: `frontend/src/api/ledger.ts`
- Modify: `frontend/src/lib/account.ts`
- Test: `frontend/src/lib/account.test.ts`

Фронт временный и будет переписан под десктоп и мобильные, поэтому логика
группировки живёт отдельной функцией: её проверяют тестом, а страница остаётся
разметкой.

- [ ] **Step 1: Написать падающий тест**

Дописать в `frontend/src/lib/account.test.ts`:

```typescript
import type { Account, Bank } from '../api/ledger'
import { groupAccountsByBank } from './account'

const banks: Bank[] = [
  { code: 'tbank', name: 'Т-Банк' },
  { code: 'sber', name: 'Сбербанк' },
  { code: 'alfa', name: 'Альфа-Банк' },
]

function acc(name: string, bank_code: string | null): Account {
  return {
    id: name,
    name,
    type: 'card',
    currency: 'RUB',
    is_archived: false,
    balance: '0.0000',
    reported_at: null,
    card_masks: [],
    bank_code,
  }
}

test('счета собираются в группы по банку', () => {
  const groups = groupAccountsByBank(
    [acc('Альфа карта', 'alfa'), acc('Т-карта', 'tbank'), acc('Альфа вклад', 'alfa')],
    banks,
  )
  expect(groups.map((g) => g.title)).toEqual(['Т-Банк', 'Альфа-Банк'])
  expect(groups[1]!.accounts.map((a) => a.name)).toEqual(['Альфа карта', 'Альфа вклад'])
})

test('порядок групп повторяет порядок счетов, а не словарь банков', () => {
  // человек привыкает к порядку своего списка; сортировать группы по внешнему
  // списку значит переставлять их при добавлении банка в словарь
  const groups = groupAccountsByBank([acc('Сбер карта', 'sber'), acc('Т-карта', 'tbank')], banks)
  expect(groups.map((g) => g.title)).toEqual(['Сбербанк', 'Т-Банк'])
})

test('счета без банка идут последней группой', () => {
  // наличные есть почти всегда, и первой группой они оттесняли бы банковские
  const groups = groupAccountsByBank([acc('Кошелёк', null), acc('Т-карта', 'tbank')], banks)
  expect(groups.map((g) => g.title)).toEqual(['Т-Банк', 'Без банка'])
})

test('счёт банка, которого нет в словаре, не пропадает из списка', () => {
  // словарь бэкенда и данные могут разъехаться при откате версии; потерять
  // счёт с деньгами из-за этого нельзя
  const groups = groupAccountsByBank([acc('Неизвестный', 'vtb')], banks)
  expect(groups.map((g) => g.title)).toEqual(['vtb'])
})

test('один банк — тоже группа', () => {
  // заголовок при единственном банке не мешает, а исчезающая группировка
  // означала бы два разных экрана вместо одного
  const groups = groupAccountsByBank([acc('Т-карта', 'tbank')], banks)
  expect(groups.map((g) => g.title)).toEqual(['Т-Банк'])
})
```

- [ ] **Step 2: Прогнать тест и увидеть падение**

```bash
cd frontend && pnpm vitest run src/lib/account.test.ts
```

Ожидаемо: `groupAccountsByBank is not a function` либо ошибка импорта.

- [ ] **Step 3: Типы API**

В `frontend/src/api/ledger.ts` в интерфейс `Account` дописать:

```typescript
  // код банка счёта; null — наличные или банк, для которого плагина нет
  bank_code: string | null
```

И добавить рядом с остальными типами и функциями:

```typescript
export interface Bank {
  code: string
  name: string
}

// счёт, который банк показал коллектору, а в приложении его нет
export interface DiscoveredAccount {
  fingerprint: string
  bank_code: string
  bank_name: string
  name: string
  currency: string | null
  balance: string | null
  card_masks: string[]
}

export function getBanks(): Promise<Bank[]> {
  return api('/api/banks')
}

export function getDiscovered(workspaceId: string): Promise<DiscoveredAccount[]> {
  return api(`/api/accounts/discovered?workspace_id=${workspaceId}`)
}
```

Подписи `api(...)` скопировать с соседних функций файла — у них уже принятая в
проекте форма вызова.

В `createAccount` расширить тип тела: `bank_code?: string | null` и
`bank_account_fingerprint?: string`.

- [ ] **Step 4: Написать группировку**

В `frontend/src/lib/account.ts` добавить:

```typescript
export interface AccountGroup {
  // ключ для React; у группы без банка своего кода нет
  key: string
  title: string
  accounts: Account[]
}

const NO_BANK = 'Без банка'

/**
 * Счета по банкам, в порядке первого появления банка в списке.
 *
 * Порядок берётся из самого списка, а не из словаря банков: человек привыкает
 * к своему списку, и добавление банка в словарь не должно переставлять группы.
 * Счёт с незнакомым кодом банка не теряется — его группа называется кодом:
 * потерять счёт с деньгами из-за разъехавшихся версий нельзя.
 */
export function groupAccountsByBank(accounts: Account[], banks: Bank[]): AccountGroup[] {
  const names = new Map(banks.map((bank) => [bank.code, bank.name]))
  const groups = new Map<string, AccountGroup>()
  for (const account of accounts) {
    const key = account.bank_code ?? NO_BANK
    const group = groups.get(key)
    if (group) {
      group.accounts.push(account)
      continue
    }
    groups.set(key, {
      key,
      title: account.bank_code === null ? NO_BANK : (names.get(account.bank_code) ?? account.bank_code),
      accounts: [account],
    })
  }
  const ordered = [...groups.values()]
  // наличные есть почти у всех, и первой группой они оттесняли бы банковские
  return ordered.filter((g) => g.key !== NO_BANK).concat(ordered.filter((g) => g.key === NO_BANK))
}
```

Импорт типов дополнить: `import type { Account, Bank } from '../api/ledger'`.

- [ ] **Step 5: Прогнать тест и увидеть, что он проходит**

```bash
cd frontend && pnpm vitest run src/lib/account.test.ts
```

Ожидаемо: проходят и новые тесты, и прежние про метку счёта.

- [ ] **Step 6: Коммит**

```bash
git add frontend/src/api/ledger.ts frontend/src/lib/account.ts frontend/src/lib/account.test.ts
git commit -m "Группировка счетов по банку и типы новых ручек"
```

---

## Task 10: Экран счетов

**Files:**
- Modify: `frontend/src/pages/AccountsPage.tsx`
- Test: `frontend/src/pages/AccountsPage.test.tsx`

- [ ] **Step 1: Написать падающие тесты**

В `frontend/src/pages/AccountsPage.test.tsx` сперва подготовить обвязку. Мок
модуля дополнить двумя функциями:

```typescript
vi.mock('../api/ledger', () => ({
  getAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  getBanks: vi.fn(),
  getDiscovered: vi.fn(),
}))
```

Импорт из `../api/ledger` расширить: `getAccounts, getBanks, getDiscovered, updateAccount` и тип `DiscoveredAccount`. В фикстуру `base` дописать `bank_code: null`.

Существующий `renderPage(account: Account)` принимает один счёт — заменить его на список плюс непривязанные, а прежние вызовы поправить на `renderPage([{ ...base, ... }])`:

```typescript
function renderPage(accounts: Account[], discovered: DiscoveredAccount[] = []) {
  vi.mocked(getAccounts).mockResolvedValue(accounts)
  vi.mocked(getBanks).mockResolvedValue([
    { code: 'tbank', name: 'Т-Банк' },
    { code: 'alfa', name: 'Альфа-Банк' },
  ])
  vi.mocked(getDiscovered).mockResolvedValue(discovered)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <AccountsPage />
      </QueryClientProvider>
    </MantineProvider>,
  )
}
```

Затем дописать тесты:

```typescript
test('счета разложены по банкам', async () => {
  renderPage([
    { ...base, name: 'Т-карта', bank_code: 'tbank' },
    { ...base, id: 'a2', name: 'Кошелёк', bank_code: null },
  ])

  expect(await screen.findByText('Т-Банк')).toBeDefined()
  expect(await screen.findByText('Без банка')).toBeDefined()
})

test('счёт банка, который не ведётся, предлагается завести', async () => {
  // без этого блока привязка невозможна: отпечаток человеку взять неоткуда
  renderPage(
    [],
    [
      {
        fingerprint: 'a'.repeat(64),
        bank_code: 'alfa',
        bank_name: 'Альфа-Банк',
        name: 'Текущий счёт',
        currency: 'RUB',
        balance: '1000.0000',
        card_masks: ['1234'],
      },
    ],
  )

  expect(await screen.findByText(/есть в банке/i)).toBeDefined()
  expect(await screen.findByText('Текущий счёт')).toBeDefined()
  expect(await screen.findByText('•• 1234')).toBeDefined()
})

test('блока непривязанных нет, когда привязано всё', async () => {
  // пустой заголовок — шум на экране, который человек учится пропускать
  renderPage([{ ...base, name: 'Т-карта', bank_code: 'tbank' }], [])
  expect(await screen.findByText('Т-Банк')).toBeDefined()
  expect(screen.queryByText(/есть в банке/i)).toBeNull()
})
```

Счёт в новых тестах назван не «Т-Банк» намеренно: имя из фикстуры `base` совпадает с заголовком группы, и `findByText` нашёл бы два совпадения вместо проверки заголовка.

- [ ] **Step 2: Прогнать тесты и увидеть падение**

```bash
cd frontend && pnpm vitest run src/pages/AccountsPage.test.tsx
```

Ожидаемо: падают на отсутствии заголовков групп и блока непривязанных.

- [ ] **Step 3: Переписать страницу**

В `frontend/src/pages/AccountsPage.tsx`:

- добавить запросы:

```typescript
  const { data: banks } = useQuery({ queryKey: ['banks'], queryFn: getBanks })
  const { data: discovered } = useQuery({
    queryKey: ['discovered', ws],
    queryFn: () => getDiscovered(ws),
  })
```

- заменить `accounts?.map(...)` на отрисовку групп:

```tsx
      {groupAccountsByBank(accounts ?? [], banks ?? []).map((group) => (
        <Stack key={group.key} gap="xs">
          <Title order={4}>{group.title}</Title>
          {group.accounts.map((a) => (
            /* карточку счёта оставить как есть, целиком */
          ))}
        </Stack>
      ))}
```

- добавить блок непривязанных после списка групп:

```tsx
      {discovered && discovered.length > 0 && (
        <Stack gap="xs">
          <Title order={4}>Есть в банке, но не ведётся</Title>
          {discovered.map((item) => (
            <Card key={item.fingerprint} withBorder>
              <Group justify="space-between">
                <div>
                  <Text fw={500}>{item.name}</Text>
                  <Text c="dimmed" size="sm">
                    {item.bank_name}
                    {item.card_masks.length > 0 &&
                      ` · ${item.card_masks.map((m) => `•• ${m}`).join(', ')}`}
                  </Text>
                </div>
                <Group>
                  {item.balance && item.currency && (
                    <Text fw={700}>{formatMoney(item.balance, item.currency)}</Text>
                  )}
                  <Button variant="light" size="xs" onClick={() => openFromDiscovered(item)}>
                    Завести счёт
                  </Button>
                </Group>
              </Group>
            </Card>
          ))}
        </Stack>
      )}
```

- добавить открытие формы из непривязанного счёта:

```typescript
  const openFromDiscovered = (item: DiscoveredAccount) => {
    setEditing(null)
    updateMut.reset()
    // имя и валюту подставляем из банка, тип человек выбирает сам: банковского
    // типа счёта мы не принимаем — это слово банка
    form.setValues({
      name: item.name,
      type: 'card',
      currency: item.currency ?? 'RUB',
      balance: '',
      bank_code: item.bank_code,
      bank_account_fingerprint: item.fingerprint,
    })
    open()
  }
```

- расширить `initialValues` формы полями `bank_code: null as string | null` и
  `bank_account_fingerprint: ''`, а в `submit` при создании передавать их:

```typescript
    if (!editing) {
      createMut.mutate({
        name: v.name,
        type: v.type,
        currency: v.currency,
        bank_code: v.bank_code,
        bank_account_fingerprint: v.bank_account_fingerprint || undefined,
      })
      return
    }
```

- в форме показать выбор банка, когда счёт заводится руками (у привязанного
  банк уже определён отпечатком):

```tsx
          {!editing && !form.values.bank_account_fingerprint && (
            <Select
              label="Банк"
              placeholder="Без банка"
              clearable
              mt="sm"
              data={(banks ?? []).map((b) => ({ value: b.code, label: b.name }))}
              {...form.getInputProps('bank_code')}
            />
          )}
```

- после успешного создания обновлять и список непривязанных:

```typescript
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      await queryClient.invalidateQueries({ queryKey: ['discovered', ws] })
```

- дописать импорты: `getBanks`, `getDiscovered`, тип `DiscoveredAccount` из
  `../api/ledger`, `groupAccountsByBank` из `../lib/account`.

- [ ] **Step 4: Прогнать тесты и увидеть, что они проходят**

```bash
cd frontend && pnpm vitest run src/pages/AccountsPage.test.tsx
```

Ожидаемо: проходят и новые тесты, и прежние.

- [ ] **Step 5: Прогнать весь фронт, линт и типы**

```bash
cd frontend && pnpm test && pnpm lint && pnpm build
```

Ожидаемо: зелено. `DashboardPage.test.tsx` может потребовать `bank_code` в
фикстуре счёта — дописать `bank_code: null`.

- [ ] **Step 6: Коммит**

```bash
git add frontend
git commit -m "Экран счетов: группы по банкам и заведение счёта из показанного банком"
```

---

## Task 11: Справочник

`docs/reference/` описывает состояние системы, и правится он в том же
изменении, что и поведение, — этого требуют ворота CI: правка `*/service.py`
или `collector/src/core/*` без правки `docs/reference/` красит сборку.

**Files:**
- Modify: `docs/reference/ledger.md`
- Modify: `docs/reference/collector.md`

- [ ] **Step 1: Дописать в `docs/reference/ledger.md` раздел про банк**

Содержание — гарантии, а не пересказ кода. Что должно быть сказано:

- у счёта есть необязательный банк из словаря ядра; пусто — наличные или банк,
  для которого плагина нет, и такой счёт работает везде наравне с остальными;
- привязка к счёту банка хранится отпечатком, а не идентификатором: сырой
  идентификатор в приложение не приезжает вовсе, и по базе нельзя ответить,
  что это был за счёт, — счёт узнаётся по имени, маскам карт и типу;
- один счёт банка соответствует одному счёту приложения, и это держит
  ограничение в базе, а не согласие сторон;
- увиденные счета — то, что банк показал, а в приложении не заведено; список
  заменяется целиком при каждом сборе, и строка исчезает при заведении счёта;
- завести счёт с отпечатком можно только из увиденного: произвольный отпечаток
  получает отказ;
- банковского типа счёта приложение не принимает — тип выбирает человек.

Каждое утверждение должно опираться на строку кода, которую можно назвать. Что
не проверено кодом — не писать.

- [ ] **Step 2: Поправить `docs/reference/collector.md`**

Заменить описание соответствия счетов: коллектор больше не читает его из
переменной окружения, а сообщает приложению список счетов банка и получает
привязки. Сказать и то, что сбор без единой привязки — штатное завершение, а не
ошибка, и что сырой идентификатор счёта остаётся на машине владельца.

- [ ] **Step 3: Проверить, что упоминаний старой переменной не осталось**

```bash
grep -rn "AICCOUNTANT_ACCOUNTS" docs/ collector/ backend/ || echo "упоминаний нет"
```

Ожидаемо: «упоминаний нет».

- [ ] **Step 4: Сверить ворота документации с цифрами**

```bash
node scripts/docs-gate-stats.mjs
```

Ожидаемо: список файлов-носителей контракта покрывает то, что мы меняли
(`*/service.py`, `collector/src/core/*`). Если ворота на эту работу молчали —
значит список узок, и это надо записать в `docs/backlog.md` пунктом с цифрами,
а не молча расширять.

- [ ] **Step 5: Коммит**

```bash
git add docs/reference
git commit -m "Справочник: банк у счёта, привязка по отпечатку, увиденные счета"
```

---

## Task 12: Проверка целиком и защита от зелёных пустышек

Зелёный прогон здесь доказательством не считается. Прежде чем звать работу
готовой, каждый сторож проверяется внесением дефекта: правка вносится, тест
должен покраснеть, правка откатывается.

- [ ] **Step 1: Прогнать всё**

```bash
cd backend && uv run ruff format --check . && uv run ruff check . && uv run mypy app && uv run pytest
```

```bash
cd collector && pnpm test && pnpm lint && pnpm build
```

```bash
cd frontend && pnpm test && pnpm lint && pnpm build
```

Ожидаемо: три зелёных прогона. Результат подтвердить выводом, а не памятью.

- [ ] **Step 2: Проверить сторожей дефектами**

Внести по одному, прогнать названный тест, убедиться, что он красный, откатить:

| Дефект | Файл | Должен покраснеть |
|---|---|---|
| убрать фильтр по `bank_code` в `replace_discovered` | `backend/app/ledger/repository.py` | `test_other_bank_accounts_survive_sync` |
| убрать фильтр по `workspace_id` в `list_discovered` | `backend/app/ledger/repository.py` | `test_seen_accounts_are_isolated_by_workspace` |
| убрать фильтр по `workspace_id` в `linked_bank_accounts` | `backend/app/ledger/repository.py` | `test_links_do_not_leak_between_workspaces` |
| убрать `if item.fingerprint not in linked` в `sync_discovered` | `backend/app/ledger/service.py` | `test_account_created_from_seen_one_gets_bank` |
| не удалять `discovered` в `create_account` | `backend/app/ledger/service.py` | `test_second_account_on_same_bank_account_is_refused` |
| вернуть `linked` без фильтра по `shown` | `backend/app/ledger/service.py` | `test_linked_account_gone_from_bank_is_not_returned` |
| убрать банк из строки отпечатка | `collector/src/runner/fingerprint.ts` | «одинаковые идентификаторы в разных банках дают разные отпечатки» |
| отправлять `type: account.type` в теле | `collector/src/runner/discovered.ts` | «банковский тип счёта в приложение не отправляется» |
| поставить группу «Без банка» первой | `frontend/src/lib/account.ts` | «счета без банка идут последней группой» |
| убрать `unique=True` у `uq_accounts_bank_fingerprint` | `backend/alembic/versions/0014_bank_on_account.py` | `test_one_bank_account_maps_to_one_app_account` |

Снятие `postgresql_where` с этого индекса дефектом **не является** — проверено
при исполнении Task 2: Postgres считает NULL различными, и счета без отпечатка
не конфликтуют ни с частичным индексом, ни с обычным. Предикат здесь экономия и
объявление намерения; правило держится на `unique=True`.

Если какой-то тест на свой дефект не покраснел — он ничего не проверяет, и
чинить надо тест, а не продолжать.

- [ ] **Step 3: Записать результат проверки**

Итог проверки дефектами — в описание PR: какой дефект вносили и какой тест
упал. Это единственное доказательство, что сторожа живые.

- [ ] **Step 4: Сверить справочник с дифом**

```bash
git diff origin/main --stat
```

Прочитать `docs/reference/ledger.md` и `collector.md` рядом с дифом: описывают
ли они то, что код делает теперь, а не то, что делал раньше. Генерация и ворота
этого не ловят — они видят факт правки, а не её смысл.

- [ ] **Step 5: Проверить генерацию**

```bash
cd backend && uv run python scripts/gen_reference.py && cd ../collector && pnpm reference && cd .. && git status --short docs/reference/generated
```

Ожидаемо: пусто — сгенерированное уже в коммитах и коду соответствует.

- [ ] **Step 6: Открыть PR**

```bash
git push -u origin spec/bank-entity
```

Заголовок: «Банк у счёта: привязка счетов банка и группировка списка». В теле —
что делает работа, чем платим (отпечаток необратим, переменная окружения
исчезает без переходного периода) и таблица «дефект → упавший тест» из Step 2.

---

## Проверка плана по спеке

| Раздел спеки | Где сделано |
|---|---|
| §4 словарь банков | Task 1 |
| §5.1 колонки счёта, индекс, ограничение | Task 2 |
| §5.2 `discovered_accounts` без типа счёта | Task 2, Task 4 |
| §6 отпечаток | Task 6, проверка в Task 4 (шаблон `^[0-9a-f]{64}$`) |
| §7.1 ручка и её отказы | Task 4 |
| §7.2 уход `AICCOUNTANT_ACCOUNTS` | Task 8 |
| §7.3 порядок сбора | Task 8 |
| §8 экран | Task 9, Task 10 |
| §9 проверки | Tasks 2, 4, 5, 6, 7, 9, 10; дефекты — Task 12 |
| §11 привязка существующего счёта, устаревшие строки | сознательно не делаем: открытые вопросы спеки |
