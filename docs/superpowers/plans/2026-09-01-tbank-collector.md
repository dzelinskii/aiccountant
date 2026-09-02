# Коллектор операций Т-Банка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Забирать операции из ЛК Т-Банка на машине пользователя и отдавать их приложению, не храня ни пароля, ни лишних прав.

**Architecture:** Ядро (плагин банка, TypeScript, только HTTP с allowlist) отделено от оболочки (локальный раннер: окно логина, чтение токена из профиля браузера, отправка в API). Бэкенд получает два дополнения: API-токены в `identity` и эндпоинт приёма уже разобранных операций, который вливается в существующий конвейер импорта.

**Tech Stack:** Backend — Python 3.12, FastAPI, SQLAlchemy 2 async, Alembic, argon2/sha256. Collector — TypeScript, Node, Playwright (только для окна логина), vitest.

**Спека:** `docs/superpowers/specs/2026-09-01-tbank-collector-design.md` — читать §3 (безопасность) и §6 (факты о API банка) перед задачами 4–6.

**Существующие соглашения (важно для исполнителя):**
- Backend из `backend/`: `uv run ruff format .`, `uv run ruff check .`, `uv run mypy`, `uv run lint-imports`, `uv run pytest`. Сейчас 192 теста зелёные.
- Collector из `collector/`: `pnpm test`, `pnpm lint`, `pnpm build`.
- Деньги — `Decimal`/`NUMERIC`, `float` запрещён; на проводе и в JSON — строками.
- В логи только идентификаторы: никогда токен, телефон, код из СМС, описания операций, суммы, номера счетов и карт.
- Каждый запрос фильтрует по `workspace_id`; утечка между workspace — критический баг.
- Комментарии и коммиты на русском, объясняют «почему»; без `Co-Authored-By`.
- Схема БД — только через миграции Alembic. Последняя — `0007_import_async`.
- pytest `asyncio_mode=auto` (async-тесты без декоратора); фикстура `db_session` поднимает Postgres и применяет миграции до head.
- Реальные данные банка в репозиторий не попадают: фикстуры синтетические, построенные по описанию полей из §6 спеки.

---

## Карта файлов

Создаются (backend):
- `backend/alembic/versions/0008_api_tokens.py` — миграция таблицы токенов.
- `backend/app/identity/tokens.py` — генерация, хеширование, проверка токена.
- `backend/tests/test_api_tokens.py`, `backend/tests/test_imports_parsed.py`.

Модифицируются (backend):
- `backend/app/identity/models.py` — модель `ApiToken`.
- `backend/app/identity/deps.py` — `get_current_user` принимает и сессию, и токен.
- `backend/app/identity/router.py` — создание, список, отзыв токенов.
- `backend/app/identity/schemas.py`, `backend/app/identity/service.py`.
- `backend/app/imports/router.py` — `POST /api/imports/parsed`.
- `backend/app/imports/service.py` — `create_parsed_import`.
- `backend/app/imports/schemas.py` — схема входящих операций.

Создаются (collector, новый корневой каталог):
- `collector/package.json`, `collector/tsconfig.json`, `collector/vitest.config.ts`.
- `collector/src/http/allowlist-client.ts` — HTTP-клиент, физически неспособный на лишнее.
- `collector/src/http/lossless-json.ts` — разбор JSON без потери точности чисел.
- `collector/src/plugins/tbank/types.ts`, `client.ts`, `map.ts`, `index.ts` — ядро.
- `collector/src/runner/session.ts` — окно логина и добыча токена.
- `collector/src/runner/push.ts` — отправка в API приложения.
- `collector/src/runner/main.ts` — точка входа.
- `collector/tests/fixtures/*.json` — синтетические ответы банка.
- Тесты рядом с модулями: `*.test.ts`.

---

## Task 1: Модель API-токена и миграция 0008

**Files:**
- Modify: `backend/app/identity/models.py`
- Create: `backend/alembic/versions/0008_api_tokens.py`
- Create: `backend/app/identity/tokens.py`
- Test: `backend/tests/test_api_tokens.py`

- [ ] **Step 1: Написать падающий тест генерации и хеширования**

Создать `backend/tests/test_api_tokens.py`:

```python
from app.identity.tokens import generate_token, hash_token


def test_generate_token_is_long_and_unique() -> None:
    a, b = generate_token(), generate_token()
    assert a != b
    # 32 байта в base64url — подбор невозможен, поэтому хеш может быть быстрым
    assert len(a) >= 43


def test_hash_token_is_deterministic_and_not_the_token() -> None:
    token = generate_token()
    assert hash_token(token) == hash_token(token)
    assert hash_token(token) != token
    assert len(hash_token(token)) == 64  # sha256 hex


def test_different_tokens_hash_differently() -> None:
    assert hash_token(generate_token()) != hash_token(generate_token())
```

- [ ] **Step 2: Прогнать — падает**

Run: `uv run pytest tests/test_api_tokens.py -q`
Expected: FAIL — нет модуля `app.identity.tokens`.

- [ ] **Step 3: Реализовать генерацию и хеширование**

Создать `backend/app/identity/tokens.py`:

```python
import hashlib
import secrets

TOKEN_BYTES = 32


def generate_token() -> str:
    """Токен для программного доступа: 32 байта из криптостойкого генератора."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """sha256, а не argon2: токен высокоэнтропийный, подбор невозможен, зато по
    детерминированному хешу можно искать в индексе за один запрос."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
```

- [ ] **Step 4: Добавить модель**

В `backend/app/identity/models.py` добавить в конец (импорты `DateTime`, `ForeignKey`, `String`, `func` в файле уже есть):

```python
class ApiToken(Base):
    """Токен для программного доступа к workspace: им пользуется коллектор,
    у которого нет браузерной сессии."""

    __tablename__ = "api_tokens"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(100))
    # сам токен не храним — только хеш; показываем его один раз при создании
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

- [ ] **Step 5: Написать миграцию 0008**

Создать `backend/alembic/versions/0008_api_tokens.py`:

```python
"""Токены для программного доступа (коллектор)"""

import sqlalchemy as sa

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "api_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["workspaces.id"], name=op.f("fk_api_tokens_workspace_id_workspaces")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_api_tokens_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_api_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_api_tokens_token_hash")),
    )


def downgrade() -> None:
    op.drop_table("api_tokens")
```

- [ ] **Step 6: Добавить тест миграции**

В `backend/tests/test_migrations.py` добавить по образцу соседних тестов файла (те же фикстуры, тот же запрос к `information_schema`):

```python
async def test_migrations_create_api_tokens(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text("SELECT column_name FROM information_schema.columns WHERE table_name = 'api_tokens'")
        )
        columns = {name for (name,) in rows.all()}
    await engine.dispose()
    assert {"id", "workspace_id", "name", "token_hash", "revoked_at"} <= columns
```

- [ ] **Step 7: Прогнать**

Run: `uv run pytest tests/test_api_tokens.py tests/test_migrations.py -q`
Expected: PASS.

- [ ] **Step 8: Гейты и коммит**

Run: `uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest -q`

```bash
git add app/identity/models.py app/identity/tokens.py alembic/versions/0008_api_tokens.py tests/test_api_tokens.py tests/test_migrations.py
git commit -m "Identity: модель API-токена и миграция 0008"
```

---

## Task 2: Аутентификация по токену и управление токенами

**Files:**
- Modify: `backend/app/identity/deps.py`
- Modify: `backend/app/identity/service.py`, `schemas.py`, `router.py`
- Test: `backend/tests/test_api_tokens.py` (дополнить)

Сейчас `get_current_user` смотрит только на куку сессии. Учим его принимать ещё и `Authorization: Bearer <token>`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `backend/tests/test_api_tokens.py` (импорты — вверх файла):

```python
import uuid

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _ws(client: AsyncClient) -> str:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


async def test_create_token_returns_value_once(client: AsyncClient) -> None:
    ws = await _ws(client)
    resp = await client.post(
        "/api/tokens", params={"workspace_id": ws}, json={"name": "коллектор"}
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["token"]  # сам токен отдаётся только здесь
    assert body["name"] == "коллектор"

    listed = await client.get("/api/tokens", params={"workspace_id": ws})
    assert listed.status_code == 200
    assert all("token" not in t for t in listed.json())  # больше никогда не показываем


async def test_token_authorizes_api_without_session(client: AsyncClient) -> None:
    ws = await _ws(client)
    token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()  # никакой сессии — только заголовок
    resp = await client.get(
        "/api/accounts", params={"workspace_id": ws}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200


async def test_revoked_token_is_rejected(client: AsyncClient) -> None:
    ws = await _ws(client)
    created = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()
    await client.delete(f"/api/tokens/{created['id']}", params={"workspace_id": ws})

    client.cookies.clear()
    resp = await client.get(
        "/api/accounts",
        params={"workspace_id": ws},
        headers={"Authorization": f"Bearer {created['token']}"},
    )
    assert resp.status_code == 401


async def test_garbage_token_is_rejected(client: AsyncClient) -> None:
    ws = await _ws(client)
    client.cookies.clear()
    resp = await client.get(
        "/api/accounts",
        params={"workspace_id": ws},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


async def test_token_does_not_open_foreign_workspace(client: AsyncClient) -> None:
    ws = await _ws(client)
    token = (
        await client.post("/api/tokens", params={"workspace_id": ws}, json={"name": "к"})
    ).json()["token"]

    client.cookies.clear()
    resp = await client.get(
        "/api/accounts",
        params={"workspace_id": str(uuid.uuid4())},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code in (401, 403)
```

- [ ] **Step 2: Прогнать — падают**

Run: `uv run pytest tests/test_api_tokens.py -q`
Expected: FAIL — эндпоинтов `/api/tokens` нет.

- [ ] **Step 3: Научить `get_current_user` принимать токен**

В `backend/app/identity/deps.py` заменить `get_current_user` на:

```python
async def get_current_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    session: Annotated[str | None, Cookie()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    # программный доступ (коллектор, боты) — по токену; браузер — по куке сессии
    if authorization and authorization.startswith("Bearer "):
        user = await service.user_by_api_token(db, authorization.removeprefix("Bearer ").strip())
        if user is None:
            raise HTTPException(status_code=401, detail="Неверный токен")
        return user
    if session is None:
        raise HTTPException(status_code=401, detail="Не авторизован")
    user_id = await get_session_user_id(redis, session)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Сессия истекла")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user
```

Добавить импорты: `Header` из fastapi и `from app.identity import service`.

**Важно:** проверка принадлежности к workspace остаётся в `require_workspace_member` — токен даёт личность, а не доступ ко всем workspace. Поэтому токен чужого workspace упрётся в 403 там же, где и обычный пользователь.

- [ ] **Step 4: Сервис**

В `backend/app/identity/service.py` добавить:

```python
async def user_by_api_token(db: AsyncSession, token: str) -> User | None:
    """Найти владельца действующего токена. Ищем по хешу — одним запросом по индексу."""
    api_token = await db.scalar(
        select(ApiToken).where(
            ApiToken.token_hash == hash_token(token), ApiToken.revoked_at.is_(None)
        )
    )
    if api_token is None:
        return None
    api_token.last_used_at = datetime.now(UTC)
    await db.commit()
    return await db.get(User, api_token.created_by)


async def create_api_token(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, name: str
) -> tuple[ApiToken, str]:
    """Вернуть запись и сам токен — показать его можно только сейчас."""
    token = generate_token()
    api_token = ApiToken(
        workspace_id=workspace_id, created_by=user_id, name=name, token_hash=hash_token(token)
    )
    db.add(api_token)
    await db.commit()
    return api_token, token


async def list_api_tokens(db: AsyncSession, workspace_id: uuid.UUID) -> list[ApiToken]:
    rows = await db.execute(
        select(ApiToken)
        .where(ApiToken.workspace_id == workspace_id, ApiToken.revoked_at.is_(None))
        .order_by(ApiToken.created_at.desc())
    )
    return list(rows.scalars().all())


async def revoke_api_token(db: AsyncSession, workspace_id: uuid.UUID, token_id: uuid.UUID) -> bool:
    api_token = await db.scalar(
        select(ApiToken).where(ApiToken.id == token_id, ApiToken.workspace_id == workspace_id)
    )
    if api_token is None:
        return False
    api_token.revoked_at = datetime.now(UTC)
    await db.commit()
    return True
```

Импорты: `from datetime import UTC, datetime`, `from sqlalchemy import select`, `from app.identity.models import ApiToken`, `from app.identity.tokens import generate_token, hash_token`.

- [ ] **Step 5: Схемы**

В `backend/app/identity/schemas.py` добавить:

```python
class ApiTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class ApiTokenOut(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    last_used_at: datetime | None


class ApiTokenCreated(ApiTokenOut):
    # единственное место, где токен виден целиком
    token: str
```

(добавить недостающие импорты `datetime`, `Field`, если их нет.)

- [ ] **Step 6: Эндпоинты**

В `backend/app/identity/router.py` добавить:

```python
@router.post("/tokens", status_code=201)
async def create_token(
    payload: ApiTokenCreate,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ApiTokenCreated:
    api_token, token = await service.create_api_token(db, workspace_id, user.id, payload.name)
    return ApiTokenCreated(
        id=api_token.id,
        name=api_token.name,
        created_at=api_token.created_at,
        last_used_at=api_token.last_used_at,
        token=token,
    )


@router.get("/tokens")
async def list_tokens(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[ApiTokenOut]:
    rows = await service.list_api_tokens(db, workspace_id)
    return [ApiTokenOut.model_validate(t, from_attributes=True) for t in rows]


@router.delete("/tokens/{token_id}", status_code=204)
async def revoke_token(
    token_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    if not await service.revoke_api_token(db, workspace_id, token_id):
        raise HTTPException(status_code=404, detail="Токен не найден")
```

Импорты схем добавить к существующему импорту из `app.identity.schemas`.

- [ ] **Step 7: Прогнать и гейты**

Run: `uv run pytest tests/test_api_tokens.py -q` затем `uv run pytest -q`
Expected: PASS, без регрессий.

Run: `uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports`

- [ ] **Step 8: Commit**

```bash
git add app/identity/deps.py app/identity/service.py app/identity/schemas.py app/identity/router.py tests/test_api_tokens.py
git commit -m "Identity: авторизация по API-токену, создание, список и отзыв"
```

---

## Task 3: Приём уже разобранных операций

**Files:**
- Modify: `backend/app/imports/schemas.py`, `service.py`, `router.py`
- Test: `backend/tests/test_imports_parsed.py`

Коллектор отдаёт готовые операции, а не PDF. Эндпоинт кладёт их в `parsed_payload` со статусом `ready` — дальше работает существующий конвейер (превью с дедупом, коммит, автокатегоризация).

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/tests/test_imports_parsed.py`:

```python
import uuid

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}

OPS = [
    {
        "occurred_at": "2026-07-05",
        "amount": "-1150.00",
        "currency": "RUB",
        "description": "Кофейня",
        "external_id": "bank-op-1",
    },
    {
        "occurred_at": "2026-07-06",
        "amount": "5000.00",
        "currency": "RUB",
        "description": "Зарплата",
        "external_id": "bank-op-2",
    },
]


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
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


async def test_parsed_import_is_ready_immediately(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    assert resp.status_code == 200
    import_id = resp.json()["import_id"]
    assert resp.json()["status"] == "ready"

    status = await client.get(f"/api/imports/{import_id}", params={"workspace_id": ws})
    body = status.json()
    assert body["status"] == "ready"
    assert body["parser"] == "tbank_collector"
    assert body["preview"]["new_count"] == 2


async def test_commit_uses_bank_external_id_for_dedup(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    first = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    committed = await client.post(
        f"/api/imports/{first.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.json()["imported"] == 2

    # тот же набор второй раз: дедуп по external_id от банка, ничего не создаём
    second = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    again = await client.post(
        f"/api/imports/{second.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert again.json()["imported"] == 0
    assert again.json()["duplicates"] == 2


async def test_empty_operations_rejected(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": []},
    )
    assert resp.status_code == 422


async def test_foreign_account_rejected(client: AsyncClient) -> None:
    ws, _ = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": str(uuid.uuid4())},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    assert resp.status_code == 404
```

- [ ] **Step 2: Прогнать — падают**

Run: `uv run pytest tests/test_imports_parsed.py -q`
Expected: FAIL — эндпоинта нет.

- [ ] **Step 3: Схемы**

В `backend/app/imports/schemas.py` добавить:

```python
class ParsedOperationIn(BaseModel):
    occurred_at: date
    amount: Decimal
    currency: str = Field(min_length=3, max_length=3)
    description: str = Field(default="", max_length=1000)
    # идентификатор операции у банка — на нём держится дедуп
    external_id: str = Field(min_length=1, max_length=64)


class ParsedImportIn(BaseModel):
    parser: str = Field(min_length=1, max_length=30)
    operations: list[ParsedOperationIn] = Field(min_length=1)
```

(нужны импорты `Decimal`, `Field`; `date` уже есть.)

- [ ] **Step 4: Сервис**

В `backend/app/imports/service.py` добавить:

```python
async def create_parsed_import(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user_id: uuid.UUID,
    parser: str,
    operations: list[ParsedOperationIn],
) -> Import:
    """Принять уже разобранные операции: разбирать нечего, сразу ready."""
    statement = ParsedStatement(
        operations=[
            ParsedOperation(
                occurred_at=op.occurred_at,
                amount=op.amount,
                currency=op.currency,
                description=op.description,
            )
            for op in operations
        ],
        total_income=None,
        total_expense=None,
    )
    # идентификаторы от банка кладём в payload сразу: дописывать в уже
    # присвоенный JSONB нельзя — SQLAlchemy не отследит правку на месте
    payload = _statement_to_payload(statement, [])
    payload["external_ids"] = [op.external_id for op in operations]

    imp = Import(
        workspace_id=workspace_id,
        account_id=account_id,
        file_name=f"{parser}.json",
        bank_profile=parser,
        parser=parser,
        status="ready",
        stats={},
        created_by=user_id,
        parsed_payload=payload,
    )
    repository.add_import(db, imp)
    await db.commit()
    return imp
```

- [ ] **Step 5: Использовать внешние id вместо хеша**

`_external_ids` сейчас всегда считает хеш. Научим его отдавать идентификаторы банка, если они сохранены. В `backend/app/imports/service.py` добавить рядом с `_external_ids`:

```python
def _payload_external_ids(
    payload: dict[str, object], account_id: uuid.UUID, operations: list[ParsedOperation]
) -> list[str]:
    """Идентификаторы для дедупа: от банка, если он их дал, иначе наш хеш."""
    stored = payload.get("external_ids")
    if isinstance(stored, list) and len(stored) == len(operations):
        return [str(x) for x in stored]
    return _external_ids(account_id, operations)
```

и заменить вызовы `_external_ids(...)` внутри `_build_preview` и `commit_from_import` на `_payload_external_ids(payload, account_id, statement.operations)` — в обеих функциях `parsed_payload` доступен (в `_build_preview` его придётся передать параметром; поправь сигнатуру и вызов в `get_import_status`).

- [ ] **Step 6: Эндпоинт**

В `backend/app/imports/router.py` добавить:

```python
@router.post("/imports/parsed")
async def create_parsed_import(
    payload: ParsedImportIn,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ImportStartedOut:
    if not await ledger_service.account_exists(db, workspace_id, account_id):
        raise HTTPException(status_code=404, detail="Счёт не найден")
    imp = await service.create_parsed_import(
        db, workspace_id, account_id, user.id, payload.parser, payload.operations
    )
    return ImportStartedOut(import_id=imp.id, status=cast(ImportStatus, imp.status))
```

- [ ] **Step 7: Прогнать и гейты**

Run: `uv run pytest tests/test_imports_parsed.py -q` затем `uv run pytest -q`
Expected: PASS, без регрессий (важно: старые тесты дедупа по хешу должны остаться зелёными — путь с хешем сохраняется для файловых импортов).

Run: `uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports`

- [ ] **Step 8: Commit**

```bash
git add app/imports/schemas.py app/imports/service.py app/imports/router.py tests/test_imports_parsed.py
git commit -m "Импорт: приём уже разобранных операций с дедупом по идентификатору банка"
```

---

## Task 4: Каркас коллектора, HTTP-клиент с allowlist и разбор чисел

**Files:**
- Create: `collector/package.json`, `collector/tsconfig.json`, `collector/vitest.config.ts`, `collector/.gitignore`
- Create: `collector/src/http/allowlist-client.ts` + `allowlist-client.test.ts`
- Create: `collector/src/http/lossless-json.ts` + `lossless-json.test.ts`

Это фундамент безопасности из §3.2 спеки: клиент физически не может сделать ничего, кроме пяти разрешённых GET-запросов.

- [ ] **Step 1: Каркас проекта**

Создать `collector/package.json`:

```json
{
  "name": "aiccountant-collector",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "lint": "oxlint",
    "build": "tsc --noEmit",
    "collect": "tsx src/runner/main.ts"
  },
  "devDependencies": {
    "@types/node": "^22",
    "oxlint": "^1",
    "tsx": "^4",
    "typescript": "^5",
    "vitest": "^4"
  },
  "dependencies": {
    "playwright": "^1"
  }
}
```

Создать `collector/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

Создать `collector/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

Создать `collector/.gitignore`:

```
node_modules/
profile/
```

(`profile/` — персистентный профиль браузера с сессией банка; в git ему делать нечего.)

Установить: `pnpm install` из `collector/`.

- [ ] **Step 2: Падающие тесты allowlist**

Создать `collector/src/http/allowlist-client.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { AllowlistClient, NotAllowedError } from './allowlist-client'

const ALLOWED = ['/api/common/v1/session_status']

function clientWith(fetchImpl: typeof fetch) {
  return new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowedPaths: ALLOWED,
    token: 'token',
    fetchImpl,
  })
}

test('разрешённый путь уходит в сеть', async () => {
  const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await client.getJson('/api/common/v1/session_status')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('путь вне списка не доходит до сети', async () => {
  const fetchImpl = vi.fn()
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/transfer')).rejects.toBeInstanceOf(NotAllowedError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('другой хост не доходит до сети', async () => {
  const fetchImpl = vi.fn()
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('https://evil.example/api/common/v1/session_status')).rejects.toBeInstanceOf(
    NotAllowedError,
  )
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('клиент умеет только GET — метода для записи нет', () => {
  const client = clientWith(vi.fn() as unknown as typeof fetch)
  // у клиента физически отсутствуют post/put/delete
  expect((client as unknown as Record<string, unknown>).post).toBeUndefined()
  expect((client as unknown as Record<string, unknown>).put).toBeUndefined()
  expect((client as unknown as Record<string, unknown>).delete).toBeUndefined()
})

test('токен уходит в query, но не в текст ошибки', async () => {
  const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  const url = (fetchImpl.mock.calls[0]?.[0] ?? '') as string
  await client.getJson('/api/common/v1/session_status').catch((e: Error) => {
    expect(e.message).not.toContain('token')
  })
  expect(String(url)).not.toContain('undefined')
})
```

- [ ] **Step 3: Прогнать — падают**

Run (из `collector/`): `pnpm test`
Expected: FAIL — модуля нет.

- [ ] **Step 4: Реализовать клиент**

Создать `collector/src/http/allowlist-client.ts`:

```ts
import { parseLossless } from './lossless-json'

export class NotAllowedError extends Error {}

interface Options {
  baseUrl: string
  allowedPaths: readonly string[]
  token: string
  fetchImpl?: typeof fetch
}

/**
 * HTTP-клиент, который физически не способен на лишнее: только GET и только по
 * заранее перечисленным путям. Это не про доверие к коду, а про проверяемое
 * ограничение — «что коллектор может сделать» становится списком из пяти строк.
 */
export class AllowlistClient {
  private readonly baseUrl: string
  private readonly allowedPaths: readonly string[]
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor({ baseUrl, allowedPaths, token, fetchImpl = fetch }: Options) {
    this.baseUrl = baseUrl
    this.allowedPaths = allowedPaths
    this.token = token
    this.fetchImpl = fetchImpl
  }

  async getJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.allowedPaths.includes(path)) {
      // сообщение без токена и без параметров — в лог попадёт только путь
      throw new NotAllowedError(`Путь не разрешён: ${path}`)
    }
    const url = new URL(path, this.baseUrl)
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new NotAllowedError('Чужой origin')
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    url.searchParams.set('sessionid', this.token)

    // AbortSignal.timeout() держит таймер СЛАБОЙ ссылкой: созданный инлайн
    // сигнал успевает умереть до чтения тела, и подвешенное тело зависает
    // навсегда. Сохранить сигнал в переменной не спасает (V8 собирает по
    // живости). Поэтому контроллер с таймером, снимаемым в finally
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let text: string
    try {
      // redirect: 'error' обязателен — иначе allowlist обходится: он проверяется
      // ДО запроса, а ответ с Location уводит на любой origin вместе с токеном
      const res = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Банк ответил ${res.status}`)
      text = await res.text()
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Банк ответил')) throw e
      // сырую ошибку наружу не пускаем — в ней может быть URL с токеном
      throw new Error('Не удалось получить ответ банка')
    } finally {
      clearTimeout(timer)
    }
    try {
      return parseLossless(text)
    } catch {
      // текст ответа не пробрасываем: в нём описания операций и суммы, а на
      // протухшей сессии банк возвращает HTML-страницу логина
      throw new Error(`Банк вернул не JSON (${text.length} байт)`)
    }
  }
}
```

- [ ] **Step 5: Падающие тесты разбора чисел**

Создать `collector/src/http/lossless-json.test.ts`:

```ts
import { expect, test } from 'vitest'
import { parseLossless } from './lossless-json'

test('длинное число не теряет разрядов', () => {
  const raw = '{"amount": {"value": 12345678901234.5678}}'
  const parsed = parseLossless(raw) as { amount: { value: string } }
  // штатный JSON.parse здесь уже потерял бы разряд
  expect(JSON.parse(raw).amount.value.toString()).not.toBe('12345678901234.5678')
  expect(parsed.amount.value).toBe('12345678901234.5678')
})

test('обычные суммы читаются как строки', () => {
  const parsed = parseLossless('{"v": -1150.00}') as { v: string }
  expect(parsed.v).toBe('-1150.00')
})

test('строки, булевы и null не ломаются', () => {
  const parsed = parseLossless('{"s":"текст","b":true,"n":null}') as Record<string, unknown>
  expect(parsed).toEqual({ s: 'текст', b: true, n: null })
})
```

- [ ] **Step 6: Реализовать разбор**

Создать `collector/src/http/lossless-json.ts`:

```ts
/**
 * Разбор JSON, при котором числа остаются строками. Нужен, потому что банк
 * отдаёт суммы числами, а JSON.parse материализует их во float и теряет разряды
 * ещё до того, как мы что-либо проверим. Правило проекта — деньги никогда не
 * проходят через float.
 */
export function parseLossless(text: string): unknown {
  return JSON.parse(quoteNumbers(text))
}

// sticky-флаг: ищем ровно с позиции i, не нарезая строку. Строгость как у
// JSON.parse — ведущие нули не принимаем, иначе битый ответ пройдёт молча
const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y

function quoteNumbers(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  // последний значимый символ вывода — по нему видно, что дальше идёт значение
  let prev = ''
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      prev = '"'
      i += 1
      continue
    }
    NUMBER.lastIndex = i
    const num = NUMBER.exec(text)
    // на валидном JSON цифра вне строки всегда начинает значение; проверка
    // позиции нужна лишь чтобы мусор вроде {1:2} отвергался, как у JSON.parse
    if (num && (prev === ':' || prev === ',' || prev === '[' || prev === '')) {
      out += `"${num[0]}"`
      prev = '"'
      i += num[0].length
      continue
    }
    out += ch
    if (ch !== ' ' && ch !== '\n' && ch !== '\t' && ch !== '\r') prev = ch
    i += 1
  }
  return out
}
```

**Осторожно, две ловушки, проверенные замерами и мутациями:**

- Не пересканировать накопленный вывод ради определения позиции (`out.replace(/\s+$/,'')`) — разбор становится квадратичным: 12 000 операций разбираются **151 секунду** вместо долей. Помнить последний значимый символ в переменной `prev`.
- Регекс со `y` (sticky) и `lastIndex`, а не `text.slice(i)` — нарезка строки на каждом числе тоже квадратична.

- [ ] **Step 7: Прогнать и гейты**

Run (из `collector/`): `pnpm test && pnpm lint && pnpm build`
Expected: всё зелёное.

- [ ] **Step 8: Commit**

```bash
git add collector/
git commit -m "Коллектор: каркас, HTTP-клиент с allowlist и разбор JSON без потери точности"
```

---

## Task 5: Ядро — плагин Т-Банка

**Files:**
- Create: `collector/src/plugins/tbank/types.ts`, `client.ts`, `map.ts`, `index.ts`
- Create: `collector/tests/fixtures/operations.json`, `accounts.json`
- Test: `collector/src/plugins/tbank/map.test.ts`, `index.test.ts`

Поля банка описаны в §6 спеки. **Фикстуры синтетические** — суммы, описания и идентификаторы выдуманные, реальные данные в репозиторий не попадают.

- [ ] **Step 1: Синтетические фикстуры**

Создать `collector/tests/fixtures/operations.json` (форма — как у банка, значения выдуманы):

```json
{
  "resultCode": "OK",
  "payload": [
    {
      "id": "op-1",
      "status": "OK",
      "type": "Debit",
      "group": "PAY",
      "isInner": false,
      "account": "acc-1",
      "operationTime": { "milliseconds": 1783296000000 },
      "debitingTime": { "milliseconds": 1783382400000 },
      "amount": { "value": 1150.5, "currency": { "code": 643, "name": "RUB", "strCode": "643" } },
      "accountAmount": { "value": 1150.5, "currency": { "code": 643, "name": "RUB", "strCode": "643" } },
      "description": "Кофейня",
      "mcc": 5812,
      "category": { "id": "cat-food", "name": "Кафе" },
      "merchant": { "id": "m-1", "name": "Кофейня" }
    },
    {
      "id": "op-2",
      "status": "OK",
      "type": "Credit",
      "group": "INCOME",
      "isInner": false,
      "account": "acc-1",
      "operationTime": { "milliseconds": 1783468800000 },
      "debitingTime": { "milliseconds": 1783468800000 },
      "amount": { "value": 5000, "currency": { "code": 643, "name": "RUB", "strCode": "643" } },
      "accountAmount": { "value": 5000, "currency": { "code": 643, "name": "RUB", "strCode": "643" } },
      "description": "Зарплата",
      "category": { "id": "cat-salary", "name": "Зарплата" }
    },
    {
      "id": "op-3",
      "status": "FAILED",
      "type": "Debit",
      "group": "PAY",
      "isInner": false,
      "account": "acc-1",
      "operationTime": { "milliseconds": 1783555200000 },
      "debitingTime": { "milliseconds": 1783555200000 },
      "amount": { "value": 99.99, "currency": { "code": 643, "name": "RUB", "strCode": "643" } },
      "accountAmount": { "value": 99.99, "currency": { "code": 643, "name": "RUB", "strCode": "643" } },
      "description": "Неуспешная операция"
    }
  ]
}
```

Создать `collector/tests/fixtures/accounts.json`:

```json
{
  "resultCode": "OK",
  "payload": [
    {
      "id": "acc-1",
      "name": "Счёт для трат",
      "accountType": "Current",
      "currency": { "code": 643, "name": "RUB", "strCode": "643" },
      "moneyAmount": { "value": 10000, "currency": { "code": 643, "name": "RUB", "strCode": "643" } }
    },
    {
      "id": "acc-2",
      "name": "Накопительный",
      "accountType": "Saving",
      "currency": { "code": 643, "name": "RUB", "strCode": "643" },
      "moneyAmount": { "value": 500, "currency": { "code": 643, "name": "RUB", "strCode": "643" } }
    }
  ]
}
```

- [ ] **Step 2: Падающие тесты отображения**

Создать `collector/src/plugins/tbank/map.test.ts`:

```ts
import { expect, test } from 'vitest'
import fixture from '../../../tests/fixtures/operations.json'
import { toOperations } from './map'

const raw = fixture.payload as unknown[]

test('расход отрицательный, приход положительный', () => {
  const ops = toOperations(raw)
  expect(ops.find((o) => o.external_id === 'op-1')?.amount).toBe('-1150.50')
  expect(ops.find((o) => o.external_id === 'op-2')?.amount).toBe('5000.00')
})

test('неуспешные операции не импортируются', () => {
  const ops = toOperations(raw)
  expect(ops.some((o) => o.external_id === 'op-3')).toBe(false)
})

test('дата берётся из времени совершения, а не списания', () => {
  const ops = toOperations(raw)
  // operationTime 1783296000000 -> 2026-07-04, debitingTime на сутки позже
  expect(ops.find((o) => o.external_id === 'op-1')?.occurred_at).toBe('2026-07-04')
})

test('идентификатор операции банка становится external_id', () => {
  const ops = toOperations(raw)
  expect(ops.map((o) => o.external_id).sort()).toEqual(['op-1', 'op-2'])
})

test('описание берётся из description, при пустом — из мерчанта', () => {
  const ops = toOperations([
    { ...(raw[0] as Record<string, unknown>), description: '', merchant: { name: 'Продавец' } },
  ])
  expect(ops[0]?.description).toBe('Продавец')
})

test('суммы не проходят через float', () => {
  const ops = toOperations([
    {
      ...(raw[0] as Record<string, unknown>),
      accountAmount: { value: '12345678901234.5678', currency: { strCode: '643' } },
    },
  ])
  expect(ops[0]?.amount).toBe('-12345678901234.5678')
})
```

- [ ] **Step 3: Прогнать — падают**

Run: `pnpm test`
Expected: FAIL — нет `./map`.

- [ ] **Step 4: Реализовать типы и отображение**

Создать `collector/src/plugins/tbank/types.ts`:

```ts
/** Операция в том виде, в каком её принимает наше приложение. */
export interface CollectedOperation {
  occurred_at: string
  amount: string
  currency: string
  description: string
  external_id: string
}

export interface CollectedAccount {
  id: string
  name: string
  type: string
  currency: string
}
```

Создать `collector/src/plugins/tbank/map.ts`:

```ts
import type { CollectedAccount, CollectedOperation } from './types'

const CURRENCY_BY_CODE: Record<string, string> = { '643': 'RUB' }

function pick(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Сумма приходит строкой (см. lossless-json) — знак ставим по type, не считая. */
function signedAmount(raw: unknown, type: unknown): string {
  const value = String(raw ?? '0')
  const normalized = value.includes('.') ? value : `${value}.00`
  const withCents = /\.\d$/.test(normalized) ? `${normalized}0` : normalized
  const abs = withCents.replace(/^-/, '')
  return type === 'Debit' ? `-${abs}` : abs
}

function isoDate(ms: unknown): string {
  return new Date(Number(ms)).toISOString().slice(0, 10)
}

export function toOperations(raw: readonly unknown[]): CollectedOperation[] {
  const result: CollectedOperation[] = []
  for (const op of raw) {
    // неуспешные операции денег не двигали — импортировать нечего
    if (pick(op, ['status']) !== 'OK') continue
    const id = pick(op, ['id'])
    if (typeof id !== 'string' || id === '') continue

    const description =
      String(pick(op, ['description']) ?? '') || String(pick(op, ['merchant', 'name']) ?? '')
    const code = String(pick(op, ['accountAmount', 'currency', 'strCode']) ?? '643')

    result.push({
      occurred_at: isoDate(pick(op, ['operationTime', 'milliseconds'])),
      amount: signedAmount(pick(op, ['accountAmount', 'value']), pick(op, ['type'])),
      currency: CURRENCY_BY_CODE[code] ?? 'RUB',
      description,
      external_id: id,
    })
  }
  return result
}

export function toAccounts(raw: readonly unknown[]): CollectedAccount[] {
  return raw.flatMap((a) => {
    const id = pick(a, ['id'])
    if (typeof id !== 'string') return []
    const code = String(pick(a, ['currency', 'strCode']) ?? '643')
    return [
      {
        id,
        name: String(pick(a, ['name']) ?? ''),
        type: String(pick(a, ['accountType']) ?? ''),
        currency: CURRENCY_BY_CODE[code] ?? 'RUB',
      },
    ]
  })
}
```

- [ ] **Step 5: Клиент банка и точка входа плагина**

Создать `collector/src/plugins/tbank/client.ts`:

```ts
import { AllowlistClient } from '../../http/allowlist-client'

export const TBANK_BASE = 'https://www.tbank.ru'

/** Ровно то, что коллектору позволено запрашивать. Больше — нельзя. */
export const TBANK_ALLOWED = [
  '/api/common/v1/accounts_light_ib',
  '/api/common/v1/session_status',
  '/mybank/api/operations/timeline/public/legacy/v1/operations',
  '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank',
  '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user',
] as const

export const COMMON_PARAMS = {
  appName: 'supreme',
  appVersion: '0.0.1',
  origin: 'web,ib5,platform',
  platform: 'web',
}

export function createTBankClient(token: string, fetchImpl?: typeof fetch): AllowlistClient {
  return new AllowlistClient({
    baseUrl: TBANK_BASE,
    allowedPaths: TBANK_ALLOWED,
    token,
    fetchImpl,
  })
}
```

Создать `collector/src/plugins/tbank/index.ts`:

```ts
import type { AllowlistClient } from '../../http/allowlist-client'
import { COMMON_PARAMS } from './client'
import { toAccounts, toOperations } from './map'
import type { CollectedAccount, CollectedOperation } from './types'

export class SessionExpiredError extends Error {}

const OPERATIONS = '/mybank/api/operations/timeline/public/legacy/v1/operations'

function payloadOf(response: unknown): unknown[] {
  const payload = (response as { payload?: unknown }).payload
  return Array.isArray(payload) ? payload : []
}

export async function checkSession(client: AllowlistClient): Promise<void> {
  const res = (await client.getJson('/api/common/v1/session_status', COMMON_PARAMS)) as {
    resultCode?: string
  }
  if (res.resultCode !== 'OK') throw new SessionExpiredError('Сессия банка недействительна')
}

export async function fetchAccounts(client: AllowlistClient): Promise<CollectedAccount[]> {
  const res = await client.getJson('/api/common/v1/accounts_light_ib', COMMON_PARAMS)
  if ((res as { resultCode?: string }).resultCode !== 'OK') {
    throw new SessionExpiredError('Сессия банка недействительна')
  }
  return toAccounts(payloadOf(res))
}

export async function fetchOperations(
  client: AllowlistClient,
  accountId: string,
  since: Date,
  until: Date = new Date(),
): Promise<CollectedOperation[]> {
  const res = await client.getJson(OPERATIONS, {
    ...COMMON_PARAMS,
    account: accountId,
    start: String(since.getTime()),
    end: String(until.getTime()),
  })
  if ((res as { resultCode?: string }).resultCode !== 'OK') {
    throw new SessionExpiredError('Сессия банка недействительна')
  }
  return toOperations(payloadOf(res))
}
```

- [ ] **Step 6: Тест плагина на фикстурах**

Создать `collector/src/plugins/tbank/index.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import accounts from '../../../tests/fixtures/accounts.json'
import operations from '../../../tests/fixtures/operations.json'
import { createTBankClient } from './client'
import { SessionExpiredError, fetchAccounts, fetchOperations } from './index'

function clientReturning(body: unknown) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  return { client: createTBankClient('token', fetchImpl as unknown as typeof fetch), fetchImpl }
}

test('счета приводятся к нашей модели', async () => {
  const { client } = clientReturning(accounts)
  const list = await fetchAccounts(client)
  expect(list.map((a) => a.id)).toEqual(['acc-1', 'acc-2'])
  expect(list[0]?.currency).toBe('RUB')
})

test('операции забираются за период и фильтруются', async () => {
  const { client, fetchImpl } = clientReturning(operations)
  const ops = await fetchOperations(client, 'acc-1', new Date('2026-07-01'))
  expect(ops).toHaveLength(2) // FAILED отброшена
  const url = String(fetchImpl.mock.calls[0]?.[0])
  expect(url).toContain('account=acc-1')
  expect(url).toContain('start=')
})

test('недействительная сессия распознаётся', async () => {
  const { client } = clientReturning({ resultCode: 'AUTHENTICATION_FAILED' })
  await expect(fetchOperations(client, 'acc-1', new Date())).rejects.toBeInstanceOf(
    SessionExpiredError,
  )
})
```

- [ ] **Step 7: Прогнать и гейты**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: всё зелёное.

- [ ] **Step 8: Commit**

```bash
git add collector/
git commit -m "Коллектор: ядро — плагин Т-Банка и отображение в нашу модель"
```

---

## Task 6: Оболочка — логин, добыча токена и отправка в приложение

**Files:**
- Create: `collector/src/runner/session.ts`, `push.ts`, `main.ts`, `config.ts`
- Test: `collector/src/runner/push.test.ts`
- Create: `collector/README.md`

- [ ] **Step 1: Конфиг**

Создать `collector/src/runner/config.ts`:

```ts
export interface CollectorConfig {
  /** Адрес приложения: сегодня localhost, завтра — сервер. Меняется здесь и только здесь. */
  apiBaseUrl: string
  apiToken: string
  workspaceId: string
  /** Соответствие счетов банка нашим: заполняется один раз руками. */
  accountMap: Record<string, string>
  /** За сколько дней забирать операции при обычном запуске. */
  days: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const required = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`Не задана переменная ${name}`)
    return value
  }
  return {
    apiBaseUrl: env.AICCOUNTANT_URL ?? 'http://localhost:8000',
    apiToken: required('AICCOUNTANT_TOKEN'),
    workspaceId: required('AICCOUNTANT_WORKSPACE'),
    accountMap: JSON.parse(env.AICCOUNTANT_ACCOUNTS ?? '{}') as Record<string, string>,
    days: Number(env.COLLECT_DAYS ?? 30),
  }
}
```

**Замечание про секреты:** здесь лежит токен нашего приложения (не банка). Токен банка в конфиг не попадает никогда — он живёт только в профиле браузера.

- [ ] **Step 2: Добыча сессии банка**

Создать `collector/src/runner/session.ts`:

```ts
import { chromium, type BrowserContext } from 'playwright'

const PROFILE_DIR = 'profile'
const LOGIN_URL = 'https://www.tbank.ru/login/'
const MYBANK_URL = 'https://www.tbank.ru/mybank/'

/**
 * Токен банка живёт в персистентном профиле браузера: куки там шифрует сам
 * браузер средствами ОС. Отдельного хранилища секретов не заводим, в файлы и
 * переменные окружения токен не попадает.
 */
export async function obtainSessionToken(headless = true): Promise<string> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless })
  try {
    const token = await readToken(context)
    if (token) return token
    if (headless) {
      // сессии нет — нужен человек; повторяем с видимым окном
      await context.close()
      return obtainSessionToken(false)
    }
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(LOGIN_URL)
    // ждём, пока человек сам введёт телефон и код: в форму не вмешиваемся
    await page.waitForURL((url) => url.href.startsWith(MYBANK_URL), { timeout: 5 * 60_000 })
    const fresh = await readToken(context)
    if (!fresh) throw new Error('Войти не удалось: сессия не появилась')
    return fresh
  } finally {
    await context.close()
  }
}

async function readToken(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies('https://www.tbank.ru')
  return cookies.find((c) => c.name === 'psid')?.value ?? null
}

/** «Забыть» доступ к банку — удалить профиль целиком. */
export async function forgetSession(): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(PROFILE_DIR, { recursive: true, force: true })
}
```

- [ ] **Step 3: Падающие тесты отправки**

Создать `collector/src/runner/push.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import { pushOperations } from './push'

const CONFIG = {
  apiBaseUrl: 'http://app.local',
  apiToken: 'secret-token',
  workspaceId: 'ws-1',
  accountMap: {},
  days: 30,
}

const OPS = [
  {
    occurred_at: '2026-07-05',
    amount: '-1150.50',
    currency: 'RUB',
    description: 'Кофейня',
    external_id: 'op-1',
  },
]

test('операции уходят с токеном в заголовке', async () => {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ import_id: 'imp-1', status: 'ready' }), { status: 200 }),
  )
  const result = await pushOperations(CONFIG, 'acc-app', OPS, fetchImpl as unknown as typeof fetch)
  expect(result.import_id).toBe('imp-1')
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
  const url = String(fetchImpl.mock.calls[0]?.[0])
  expect(url).toContain('workspace_id=ws-1')
  expect(url).toContain('account_id=acc-app')
})

test('ошибка приложения не проглатывается', async () => {
  const fetchImpl = vi.fn(async () => new Response('{"detail":"нет"}', { status: 404 }))
  await expect(
    pushOperations(CONFIG, 'acc-app', OPS, fetchImpl as unknown as typeof fetch),
  ).rejects.toThrow()
})

test('пустой список не отправляется', async () => {
  const fetchImpl = vi.fn()
  const result = await pushOperations(CONFIG, 'acc-app', [], fetchImpl as unknown as typeof fetch)
  expect(result).toBeNull()
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('в вывод не попадают секреты, суммы и описания', async () => {
  // главное правило проекта по логам: только идентификаторы и счётчики
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')))
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => void lines.push(a.join(' ')))
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ import_id: 'imp-1', status: 'ready' }), { status: 200 }),
  )

  await pushOperations(CONFIG, 'acc-app', OPS, fetchImpl as unknown as typeof fetch)
  const output = lines.join('\n')

  expect(output).not.toContain(CONFIG.apiToken)
  expect(output).not.toContain('1150.50')
  expect(output).not.toContain('Кофейня')
  log.mockRestore()
  err.mockRestore()
})
```

- [ ] **Step 4: Реализовать отправку**

Создать `collector/src/runner/push.ts`:

```ts
import type { CollectedOperation } from '../plugins/tbank/types'
import type { CollectorConfig } from './config'

export interface PushResult {
  import_id: string
  status: string
}

export async function pushOperations(
  config: CollectorConfig,
  accountId: string,
  operations: CollectedOperation[],
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult | null> {
  if (operations.length === 0) return null
  const url = new URL('/api/imports/parsed', config.apiBaseUrl)
  url.searchParams.set('workspace_id', config.workspaceId)
  url.searchParams.set('account_id', accountId)

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ parser: 'tbank_collector', operations }),
  })
  if (!res.ok) throw new Error(`Приложение ответило ${res.status}`)
  return (await res.json()) as PushResult
}
```

- [ ] **Step 5: Точка входа**

Создать `collector/src/runner/main.ts`:

```ts
import { createTBankClient } from '../plugins/tbank/client'
import { SessionExpiredError, fetchOperations } from '../plugins/tbank/index'
import { loadConfig } from './config'
import { obtainSessionToken } from './session'
import { pushOperations } from './push'

async function main(): Promise<void> {
  const config = loadConfig()
  const token = await obtainSessionToken()
  const client = createTBankClient(token)
  const since = new Date(Date.now() - config.days * 86_400_000)

  for (const [bankAccountId, appAccountId] of Object.entries(config.accountMap)) {
    try {
      const operations = await fetchOperations(client, bankAccountId, since)
      const result = await pushOperations(config, appAccountId, operations)
      // в лог только идентификаторы и счётчики, без сумм и описаний
      console.log(
        result
          ? `счёт ${appAccountId}: собрано ${operations.length}, импорт ${result.import_id}`
          : `счёт ${appAccountId}: новых операций нет`,
      )
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        console.error('Сессия банка истекла — запустите ещё раз и войдите в открывшемся окне')
        process.exitCode = 1
        return
      }
      throw error
    }
  }
  console.log('Готово. Подтвердите импорт в приложении.')
}

await main()
```

- [ ] **Step 6: README коллектора**

Создать `collector/README.md` с разделами: что это, как настроить (`AICCOUNTANT_URL`, `AICCOUNTANT_TOKEN`, `AICCOUNTANT_WORKSPACE`, `AICCOUNTANT_ACCOUNTS`, `COLLECT_DAYS`), как получить токен приложения (страница токенов / `POST /api/tokens`), как узнать идентификаторы счетов банка (первый запуск печатает список), как запускать (`pnpm collect`), как «забыть» доступ к банку (удалить `profile/`).

Обязательно указать: **токен банка нигде не хранится в открытом виде и в конфиг не попадает**; профиль в `.gitignore`; при истечении сессии откроется окно входа, код вводит человек.

- [ ] **Step 7: Прогнать и гейты**

Run (из `collector/`): `pnpm test && pnpm lint && pnpm build`
Expected: всё зелёное.

- [ ] **Step 8: Commit**

```bash
git add collector/
git commit -m "Коллектор: оболочка — вход, добыча токена, отправка операций в приложение"
```

---

## Task 7: Список импортов и вход в них из UI

**Files:**
- Modify: `backend/app/imports/repository.py`, `service.py`, `schemas.py`, `router.py`
- Test: `backend/tests/test_imports_parsed.py` (дополнить)
- Modify: `frontend/src/api/imports.ts`, `frontend/src/pages/ImportPage.tsx`

**Зачем.** Коллектор создаёт импорт со статусом `ready` — но открыть его в UI нечем: списка импортов нет, а страница помнит `import_id` только от собственной загрузки файла. Без этой задачи собранные операции невозможно подтвердить, то есть коллектор бесполезен.

- [ ] **Step 1: Падающий тест списка**

В `backend/tests/test_imports_parsed.py` добавить:

```python
async def test_pending_imports_are_listed(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    created = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    listed = await client.get("/api/imports", params={"workspace_id": ws})
    assert listed.status_code == 200
    items = listed.json()
    assert [i["import_id"] for i in items] == [created.json()["import_id"]]
    assert items[0]["status"] == "ready"
    assert items[0]["parser"] == "tbank_collector"


async def test_committed_import_leaves_pending_list(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    created = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    await client.post(
        f"/api/imports/{created.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    listed = await client.get("/api/imports", params={"workspace_id": ws})
    assert listed.json() == []


async def test_import_list_isolated_by_workspace(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    bob = {"email": "bob@example.com", "password": "password123"}
    await client.post("/api/auth/register", json=bob)
    me = await client.get("/api/me")
    ws_bob = str(me.json()["workspaces"][0]["id"])
    listed = await client.get("/api/imports", params={"workspace_id": ws_bob})
    assert listed.json() == []
```

- [ ] **Step 2: Прогнать — падает** (`uv run pytest tests/test_imports_parsed.py -q`), эндпоинта нет.

- [ ] **Step 3: Repository**

В `backend/app/imports/repository.py`:

```python
async def list_pending(db: AsyncSession, workspace_id: uuid.UUID) -> list[Import]:
    """Разобранные, но не подтверждённые импорты — их и надо показать человеку."""
    rows = await db.execute(
        select(Import)
        .where(Import.workspace_id == workspace_id, Import.status == "ready")
        .order_by(Import.created_at.desc())
    )
    return list(rows.scalars().all())
```

- [ ] **Step 4: Схема и сервис**

В `backend/app/imports/schemas.py`:

```python
class ImportListItemOut(BaseModel):
    import_id: uuid.UUID
    account_id: uuid.UUID
    parser: str | None
    status: ImportStatus
    file_name: str
    created_at: datetime
    operations_count: int
```

(нужен импорт `datetime`.)

В `backend/app/imports/service.py`:

```python
async def list_pending_imports(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[ImportListItemOut]:
    items: list[ImportListItemOut] = []
    for imp in await repository.list_pending(db, workspace_id):
        payload = imp.parsed_payload or {}
        raw_ops = payload.get("operations")
        items.append(
            ImportListItemOut(
                import_id=imp.id,
                account_id=imp.account_id,
                parser=imp.parser,
                status=cast(ImportStatus, imp.status),
                file_name=imp.file_name,
                created_at=imp.created_at,
                operations_count=len(raw_ops) if isinstance(raw_ops, list) else 0,
            )
        )
    return items
```

- [ ] **Step 5: Эндпоинт**

В `backend/app/imports/router.py`:

```python
@router.get("/imports")
async def list_imports(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[ImportListItemOut]:
    return await service.list_pending_imports(db, workspace_id)
```

**Важно про порядок маршрутов:** объявить `GET /imports` рядом с остальными; статический путь не конфликтует с `GET /imports/{import_id}`, но если FastAPI начнёт матчить неверно — поставить статический выше.

- [ ] **Step 6: Фронт — API**

В `frontend/src/api/imports.ts` добавить:

```typescript
export interface ImportListItem {
  import_id: string
  account_id: string
  parser: string | null
  status: 'processing' | 'ready' | 'failed' | 'completed'
  file_name: string
  created_at: string
  operations_count: number
}

export const getPendingImports = (ws: string) =>
  api<ImportListItem[]>(`/api/imports?${q(ws)}`)
```

- [ ] **Step 7: Фронт — показать ожидающие импорты**

В `frontend/src/pages/ImportPage.tsx` добавить запрос `getPendingImports` и блок над формой загрузки: если список непустой — карточка «Ожидают подтверждения» со строками (дата, чем разобрано, число операций) и кнопкой «Открыть», которая ставит `setImportId(item.import_id)` — дальше работает существующий поллинг и панель превью.

Инвалидировать список после успешного коммита (добавить `['pending-imports', ws]` в `invalidate`).

- [ ] **Step 8: Прогоны и коммит**

Backend: `uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`.
Frontend: `pnpm test && pnpm lint && pnpm build`.

```bash
git add backend/app/imports/ backend/tests/test_imports_parsed.py frontend/src/api/imports.ts frontend/src/pages/ImportPage.tsx
git commit -m "Импорт: список ожидающих подтверждения и вход в них из UI"
```

---

## Финальная проверка

- [ ] **Backend:** из `backend/` — `uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`. Всё зелёное, регрессий нет.
- [ ] **Collector:** из `collector/` — `pnpm test && pnpm lint && pnpm build`. Всё зелёное.
- [ ] **Frontend:** из `frontend/` — `pnpm test && pnpm lint && pnpm build` (не трогали, но убедиться).
- [ ] **Живой прогон (ручной, делает пользователь):** поднять стек; создать токен приложения; заполнить `AICCOUNTANT_ACCOUNTS`; `pnpm collect` → откроется окно входа → ввести код → операции собрались → в UI появился импорт со статусом `ready` → подтвердить → операции в ленте, автокатегоризация отработала. Проверить, что в выводе коллектора нет сумм и описаний.
- [ ] **Проверка ограничений:** убедиться, что `profile/` не попал в git, а токен банка не встречается ни в одном файле репозитория.
- [ ] **PR** после зелёного CI.
