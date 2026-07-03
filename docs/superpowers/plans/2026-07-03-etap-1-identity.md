# Этап 1.1 «Identity» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Работающая авторизация: регистрация/вход по email+паролю (argon2, Redis-сессии, httpOnly cookie, CSRF), workspace «домохозяйство» с ролями owner/member и приглашением участников, страницы входа на Mantine — плюс фундамент БД (SQLAlchemy 2 async + Alembic) и мелкие доработки из ревью этапа 0.

**Architecture:** Модульный монолит: `app/core` (settings, db, redis, security, csrf) и `app/identity` (models, sessions, service, router, deps). Сессии — server-side в Redis, идентификатор в httpOnly cookie. Миграции Alembic применяются при старте контейнера. Интеграционные тесты — httpx против ASGI-приложения с testcontainers (postgres + redis). Frontend: react-router + TanStack Query + Mantine, `AuthGuard` по `GET /api/me`.

**Tech Stack:** SQLAlchemy 2 (async, asyncpg), Alembic, pydantic-settings, argon2-cffi, redis-py (asyncio), testcontainers; Mantine, @tanstack/react-query, react-router-dom.

---

## Правила выполнения (для каждой задачи)

- Рабочая ветка: `etap-1-identity` (создаётся в задаче 1). Работать только в ней.
- Все команды backend — через `uv run` из каталога `backend/`.
- Перед каждым коммитом: `uv run ruff check . && uv run ruff format . && uv run mypy` (backend) или `pnpm lint && pnpm test` (frontend) — чисто.
- Сообщения коммитов на русском, без Co-Authored-By.
- Интеграционные тесты требуют работающего Docker (testcontainers сам поднимет postgres/redis).

---

### Task 1: Ветка и мелкие доработки скелета

**Files:**
- Delete: неиспользуемые ассеты скаффолда в `frontend/src/assets/` и `frontend/public/`
- Modify: `frontend/index.html`
- Modify: `frontend/README.md`

- [ ] **Step 1: Создать ветку**

```bash
git checkout main && git pull && git checkout -b etap-1-identity
```

- [ ] **Step 2: Удалить мёртвые ассеты**

Найти ассеты и убедиться, что они нигде не используются (favicon из index.html не трогать):

```bash
ls frontend/src/assets frontend/public
grep -rn "assets/\|\.svg\|\.png" frontend/src frontend/index.html
```

Удалить всё из `frontend/src/assets/` и те файлы `frontend/public/`, на которые нет ссылок (ревью этапа 0 называло `src/assets/hero.png`, `react.svg`, `vite.svg`, `public/icons.svg`; файл, на который ссылается `<link rel="icon">`, оставить).

- [ ] **Step 3: Поправить index.html**

В `frontend/index.html`: `<html lang="en">` → `<html lang="ru">`, `<title>frontend</title>` → `<title>AIccountant</title>`.

- [ ] **Step 4: Заменить frontend/README.md**

```markdown
# AIccountant — frontend

React 19 + TypeScript + Vite. UI — Mantine, данные — TanStack Query.

- `pnpm dev` — дев-сервер с прокси `/api` → `localhost:8000`
- `pnpm test` — vitest
- `pnpm lint` — oxlint
- `pnpm build` — production-сборка
```

- [ ] **Step 5: Проверить и закоммитить**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: всё зелёное.

```bash
git add -A frontend
git commit -m "Этап 1: мелкие доработки скелета — ассеты, title, README фронта"
```

---

### Task 2: Зависимости backend, настройки, подключения к БД и Redis

**Files:**
- Modify: `backend/pyproject.toml` (через uv add)
- Create: `backend/app/core/__init__.py`
- Create: `backend/app/core/settings.py`
- Create: `backend/app/core/db.py`
- Create: `backend/app/core/redis.py`
- Test: `backend/tests/test_settings.py`

- [ ] **Step 1: Установить зависимости**

```bash
cd backend
uv add "sqlalchemy[asyncio]" asyncpg alembic pydantic-settings argon2-cffi redis email-validator
uv add --group dev "testcontainers[postgres,redis]"
```

- [ ] **Step 2: Написать падающий тест настроек**

`backend/tests/test_settings.py`:

```python
import pytest

from app.core.settings import Settings


def test_defaults() -> None:
    settings = Settings(_env_file=None)
    assert settings.session_ttl_days == 30
    assert settings.cookie_secure is False
    assert "asyncpg" in settings.database_url


def test_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@example:5432/db")
    settings = Settings(_env_file=None)
    assert settings.database_url == "postgresql+asyncpg://u:p@example:5432/db"
```

Run: `uv run pytest tests/test_settings.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core'`.

- [ ] **Step 3: Реализовать настройки и подключения**

В `backend/pyproject.toml` секцию `[tool.mypy]` дополнить плагином — без него
mypy не понимает служебные аргументы конструктора `BaseSettings`
(`Settings(_env_file=None)` в тестах даёт `call-arg`):

```toml
[tool.mypy]
strict = true
packages = ["app", "tests"]
plugins = ["pydantic.mypy"]
```

`backend/app/core/__init__.py` — пустой.

`backend/app/core/settings.py`:

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://aiccountant:change-me@localhost:5432/aiccountant"
    redis_url: str = "redis://localhost:6379/0"
    session_ttl_days: int = 30
    cookie_secure: bool = False
    allowed_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`backend/app/core/db.py`:

```python
from collections.abc import AsyncIterator

from sqlalchemy import MetaData
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.settings import get_settings

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


engine = create_async_engine(get_settings().database_url)
session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with session_factory() as session:
        yield session
```

`backend/app/core/redis.py`:

```python
from redis.asyncio import Redis

from app.core.settings import get_settings

redis_client: Redis = Redis.from_url(get_settings().redis_url, decode_responses=True)


async def get_redis() -> Redis:
    return redis_client
```

- [ ] **Step 4: Тест зелёный, линт, типы**

Run: `uv run pytest tests/test_settings.py -v && uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: 2 passed, всё чисто.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "Этап 1: настройки приложения и подключения к Postgres/Redis"
```

---

### Task 3: Модели identity и Alembic

**Files:**
- Create: `backend/app/identity/__init__.py`
- Create: `backend/app/identity/models.py`
- Create: `backend/alembic.ini`
- Create: `backend/alembic/env.py`
- Create: `backend/alembic/script.py.mako` (из шаблона alembic)
- Create: `backend/alembic/versions/0001_identity.py`

- [ ] **Step 1: Модели**

`backend/app/identity/__init__.py` — пустой.

`backend/app/identity/models.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(20), default="personal")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Membership(Base):
    __tablename__ = "memberships"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

- [ ] **Step 2: Инициализировать Alembic**

```bash
cd backend && uv run alembic init -t async alembic
```

Скаффолд создаст `alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`, `alembic/versions/`.

- [ ] **Step 3: Настроить env.py**

Заменить `backend/alembic/env.py` целиком:

```python
import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.db import Base
from app.core.settings import get_settings
from app.identity import models  # noqa: F401  (регистрирует таблицы в metadata)

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# URL из настроек приложения; тесты могут задать его снаружи через set_main_option
if not config.get_main_option("sqlalchemy.url"):
    config.set_main_option("sqlalchemy.url", get_settings().database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_async_migrations())
```

В `backend/alembic.ini` убедиться: `script_location = alembic`, а строку `sqlalchemy.url = ...` оставить пустой (`sqlalchemy.url =`).

- [ ] **Step 4: Первая миграция (руками, не автогеном)**

`backend/alembic/versions/0001_identity.py`:

```python
"""Таблицы identity: users, workspaces, memberships"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
    )
    op.create_table(
        "workspaces",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_workspaces")),
    )
    op.create_table(
        "memberships",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_memberships_user_id_users")),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["workspaces.id"], name=op.f("fk_memberships_workspace_id_workspaces")
        ),
        sa.PrimaryKeyConstraint("user_id", "workspace_id", name=op.f("pk_memberships")),
    )


def downgrade() -> None:
    op.drop_table("memberships")
    op.drop_table("workspaces")
    op.drop_table("users")
```

- [ ] **Step 5: Линт, типы, коммит**

Run: `uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: чисто (mypy проверяет только пакеты app и tests — alembic вне его скоупа, ruff проверяет всё).

Проверка миграции на реальной БД будет в задаче 4 (conftest с testcontainers).

```bash
git add backend
git commit -m "Этап 1: модели identity и первая миграция Alembic"
```

---

### Task 4: Тестовая инфраструктура (testcontainers) и тест миграций

**Files:**
- Create: `backend/tests/conftest.py`
- Test: `backend/tests/test_migrations.py`

- [ ] **Step 1: Написать тест миграций**

`backend/tests/test_migrations.py`:

```python
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


async def test_migrations_create_identity_tables(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' ORDER BY table_name"
            )
        )
        tables = {row[0] for row in result}
    await engine.dispose()
    assert {"users", "workspaces", "memberships"} <= tables
```

Run: `uv run pytest tests/test_migrations.py -v`
Expected: FAIL — `fixture 'database_url' not found`.

- [ ] **Step 2: Реализовать conftest**

`backend/tests/conftest.py`:

```python
from collections.abc import AsyncIterator, Iterator

import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer
from testcontainers.redis import RedisContainer

from app.core.db import get_db
from app.core.redis import get_redis
from app.main import app


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    with PostgresContainer("postgres:16", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        cfg = Config("alembic.ini")
        cfg.set_main_option("sqlalchemy.url", url)
        command.upgrade(cfg, "head")
        yield url


@pytest.fixture(scope="session")
def redis_url() -> Iterator[str]:
    with RedisContainer("redis:7") as rc:
        yield f"redis://{rc.get_container_host_ip()}:{rc.get_exposed_port(6379)}/0"


@pytest.fixture
async def db_session(database_url: str) -> AsyncIterator[AsyncSession]:
    engine = create_async_engine(database_url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE memberships, workspaces, users CASCADE"))
    await engine.dispose()


@pytest.fixture
async def redis_client(redis_url: str) -> AsyncIterator[Redis]:
    client: Redis = Redis.from_url(redis_url, decode_responses=True)
    yield client
    await client.flushdb()
    await client.aclose()


@pytest.fixture
async def client(db_session: AsyncSession, redis_client: Redis) -> AsyncIterator[AsyncClient]:
    async def override_db() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def override_redis() -> Redis:
        return redis_client

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_redis] = override_redis
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
```

В `backend/pyproject.toml` добавить точечный override — у подмодулей
testcontainers нет `py.typed`, mypy strict падает с `import-untyped`:

```toml
[[tool.mypy.overrides]]
module = ["testcontainers.postgres", "testcontainers.redis"]
ignore_missing_imports = true
```

- [ ] **Step 3: Тест зелёный**

Run: `uv run pytest tests/test_migrations.py -v`
Expected: PASS (первый запуск скачает образы postgres/redis — может занять минуту-две).

- [ ] **Step 4: Линт, типы, полный прогон, коммит**

Run: `uv run pytest -v && uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: все тесты зелёные, всё чисто.

```bash
git add backend/tests
git commit -m "Этап 1: тестовая инфраструктура на testcontainers и тест миграций"
```

---

### Task 5: Пароли и сессии

**Files:**
- Create: `backend/app/core/security.py`
- Create: `backend/app/identity/sessions.py`
- Test: `backend/tests/test_security.py`
- Test: `backend/tests/test_sessions.py`

- [ ] **Step 1: Падающие тесты**

`backend/tests/test_security.py`:

```python
from app.core.security import hash_password, verify_password


def test_hash_is_not_plaintext() -> None:
    hashed = hash_password("secret-password")
    assert hashed != "secret-password"
    assert hashed.startswith("$argon2")


def test_verify_roundtrip() -> None:
    hashed = hash_password("secret-password")
    assert verify_password(hashed, "secret-password") is True
    assert verify_password(hashed, "wrong-password") is False
```

`backend/tests/test_sessions.py`:

```python
import uuid

from redis.asyncio import Redis

from app.identity.sessions import create_session, delete_session, get_session_user_id


async def test_session_roundtrip(redis_client: Redis) -> None:
    user_id = uuid.uuid4()
    token = await create_session(redis_client, user_id)
    assert await get_session_user_id(redis_client, token) == user_id
    await delete_session(redis_client, token)
    assert await get_session_user_id(redis_client, token) is None


async def test_unknown_token_returns_none(redis_client: Redis) -> None:
    assert await get_session_user_id(redis_client, "no-such-token") is None
```

Run: `uv run pytest tests/test_security.py tests/test_sessions.py -v`
Expected: FAIL — модули не существуют.

- [ ] **Step 2: Реализация**

`backend/app/core/security.py`:

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False
```

`backend/app/identity/sessions.py`:

```python
import secrets
import uuid

from redis.asyncio import Redis

from app.core.settings import get_settings

_PREFIX = "session:"


def _ttl_seconds() -> int:
    return get_settings().session_ttl_days * 24 * 60 * 60


async def create_session(redis: Redis, user_id: uuid.UUID) -> str:
    token = secrets.token_urlsafe(32)
    await redis.set(_PREFIX + token, str(user_id), ex=_ttl_seconds())
    return token


async def get_session_user_id(redis: Redis, token: str) -> uuid.UUID | None:
    value = await redis.get(_PREFIX + token)
    return uuid.UUID(value) if value else None


async def delete_session(redis: Redis, token: str) -> None:
    await redis.delete(_PREFIX + token)
```

- [ ] **Step 3: Тесты зелёные, линт, коммит**

Run: `uv run pytest tests/test_security.py tests/test_sessions.py -v && uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: 4 passed, чисто.

```bash
git add backend
git commit -m "Этап 1: хеширование паролей argon2 и Redis-сессии"
```

---

### Task 6: Auth API — регистрация, вход, выход, /me

**Files:**
- Create: `backend/app/identity/schemas.py`
- Create: `backend/app/identity/service.py`
- Create: `backend/app/identity/deps.py`
- Create: `backend/app/identity/router.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_auth_api.py`

- [ ] **Step 1: Падающие тесты**

`backend/tests/test_auth_api.py`:

```python
from httpx import AsyncClient

REGISTER = {"email": "alice@example.com", "password": "password123"}


async def test_register_creates_user_and_workspace(client: AsyncClient) -> None:
    response = await client.post("/api/auth/register", json=REGISTER)
    assert response.status_code == 201
    assert response.json()["email"] == "alice@example.com"
    assert "session" in response.cookies

    me = await client.get("/api/me")
    assert me.status_code == 200
    body = me.json()
    assert body["email"] == "alice@example.com"
    assert len(body["workspaces"]) == 1
    assert body["workspaces"][0]["role"] == "owner"


async def test_register_duplicate_email_conflict(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    response = await client.post("/api/auth/register", json=REGISTER)
    assert response.status_code == 409


async def test_register_short_password_rejected(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register", json={"email": "bob@example.com", "password": "short"}
    )
    assert response.status_code == 422


async def test_login_and_wrong_password(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    client.cookies.clear()

    ok = await client.post("/api/auth/login", json=REGISTER)
    assert ok.status_code == 200
    assert "session" in ok.cookies

    client.cookies.clear()
    bad = await client.post(
        "/api/auth/login", json={"email": "alice@example.com", "password": "wrong-password"}
    )
    assert bad.status_code == 401


async def test_me_requires_auth(client: AsyncClient) -> None:
    response = await client.get("/api/me")
    assert response.status_code == 401


async def test_logout_kills_session(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    assert (await client.get("/api/me")).status_code == 200

    logout = await client.post("/api/auth/logout")
    assert logout.status_code == 204
    assert (await client.get("/api/me")).status_code == 401


async def test_email_case_insensitive(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=REGISTER)
    dup = await client.post(
        "/api/auth/register", json={"email": "Alice@Example.com", "password": "password123"}
    )
    assert dup.status_code == 409

    client.cookies.clear()
    login = await client.post(
        "/api/auth/login", json={"email": "ALICE@example.com", "password": "password123"}
    )
    assert login.status_code == 200
```

Run: `uv run pytest tests/test_auth_api.py -v`
Expected: FAIL — 404 (роуты не существуют).

- [ ] **Step 2: Схемы и сервис**

`backend/app/identity/schemas.py`:

```python
import uuid

from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    role: str


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    workspaces: list[WorkspaceOut]


class MemberIn(BaseModel):
    email: EmailStr
```

`backend/app/identity/service.py`:

```python
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password, verify_password
from app.identity.models import Membership, User, Workspace

DEFAULT_WORKSPACE_NAME = "Домохозяйство"


class EmailTakenError(Exception):
    pass


class AlreadyMemberError(Exception):
    pass


async def register_user(db: AsyncSession, email: str, password: str) -> User:
    # email нормализуется к нижнему регистру: Alice@x.com и alice@x.com — один адрес
    email = email.lower()
    existing = await db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise EmailTakenError
    user = User(email=email, password_hash=hash_password(password))
    workspace = Workspace(name=DEFAULT_WORKSPACE_NAME, type="personal")
    db.add_all([user, workspace])
    await db.flush()
    db.add(Membership(user_id=user.id, workspace_id=workspace.id, role="owner"))
    await db.commit()
    return user


async def authenticate(db: AsyncSession, email: str, password: str) -> User | None:
    user = await db.scalar(select(User).where(User.email == email.lower()))
    if user is None or not verify_password(user.password_hash, password):
        return None
    return user


async def list_workspaces(
    db: AsyncSession, user_id: uuid.UUID
) -> list[tuple[Workspace, str]]:
    rows = await db.execute(
        select(Workspace, Membership.role)
        .join(Membership, Membership.workspace_id == Workspace.id)
        .where(Membership.user_id == user_id)
    )
    return [(workspace, role) for workspace, role in rows.all()]


async def invite_member(db: AsyncSession, workspace_id: uuid.UUID, email: str) -> Membership:
    user = await db.scalar(select(User).where(User.email == email.lower()))
    if user is None:
        raise LookupError(email)
    existing = await db.get(Membership, (user.id, workspace_id))
    if existing is not None:
        raise AlreadyMemberError
    membership = Membership(user_id=user.id, workspace_id=workspace_id, role="member")
    db.add(membership)
    await db.commit()
    return membership
```

- [ ] **Step 3: Зависимости и роутер**

`backend/app/identity/deps.py`:

```python
import uuid
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.redis import get_redis
from app.identity.models import Membership, User
from app.identity.sessions import get_session_user_id

SESSION_COOKIE = "session"


async def get_current_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    session: Annotated[str | None, Cookie()] = None,
) -> User:
    if session is None:
        raise HTTPException(status_code=401, detail="Не авторизован")
    user_id = await get_session_user_id(redis, session)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Сессия истекла")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user


async def require_owner(
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    membership = await db.get(Membership, (user.id, workspace_id))
    if membership is None or membership.role != "owner":
        raise HTTPException(status_code=403, detail="Требуется роль владельца")
    return user
```

`backend/app/identity/router.py`:

```python
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.redis import get_redis
from app.core.settings import get_settings
from app.identity import service, sessions
from app.identity.deps import SESSION_COOKIE, get_current_user
from app.identity.models import User
from app.identity.schemas import LoginIn, MeOut, RegisterIn, UserOut, WorkspaceOut

router = APIRouter(prefix="/api")


def _set_session_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_ttl_days * 24 * 60 * 60,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


@router.post("/auth/register", status_code=201)
async def register(
    payload: RegisterIn,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> UserOut:
    try:
        user = await service.register_user(db, payload.email, payload.password)
    except service.EmailTakenError:
        raise HTTPException(status_code=409, detail="Email уже зарегистрирован") from None
    token = await sessions.create_session(redis, user.id)
    _set_session_cookie(response, token)
    return UserOut(id=user.id, email=user.email)


@router.post("/auth/login")
async def login(
    payload: LoginIn,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> UserOut:
    user = await service.authenticate(db, payload.email, payload.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    token = await sessions.create_session(redis, user.id)
    _set_session_cookie(response, token)
    return UserOut(id=user.id, email=user.email)


@router.post("/auth/logout", status_code=204)
async def logout(
    response: Response,
    redis: Annotated[Redis, Depends(get_redis)],
    session: Annotated[str | None, Cookie()] = None,
) -> None:
    if session is not None:
        await sessions.delete_session(redis, session)
    response.delete_cookie(SESSION_COOKIE)


@router.get("/me")
async def me(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> MeOut:
    pairs = await service.list_workspaces(db, user.id)
    return MeOut(
        id=user.id,
        email=user.email,
        workspaces=[
            WorkspaceOut(id=workspace.id, name=workspace.name, role=role)
            for workspace, role in pairs
        ],
    )
```

Обновить `backend/app/main.py` целиком:

```python
from fastapi import FastAPI

from app.identity.router import router as identity_router
from app.logging import configure_logging

configure_logging()

app = FastAPI(title="AIccountant")
app.include_router(identity_router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 4: Тесты зелёные, линт, коммит**

Run: `uv run pytest -v && uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: все тесты (settings, migrations, security, sessions, auth_api, health) зелёные.

```bash
git add backend
git commit -m "Этап 1: auth API — регистрация, вход, выход, /me"
```

---

### Task 7: CSRF — проверка Origin

**Files:**
- Create: `backend/app/core/csrf.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_csrf.py`

- [ ] **Step 1: Падающий тест**

`backend/tests/test_csrf.py`:

```python
from httpx import AsyncClient

PAYLOAD = {"email": "csrf@example.com", "password": "password123"}


async def test_unsafe_request_with_foreign_origin_rejected(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register", json=PAYLOAD, headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 403


async def test_same_origin_allowed(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register", json=PAYLOAD, headers={"Origin": "http://test"}
    )
    assert response.status_code == 201


async def test_get_with_foreign_origin_allowed(client: AsyncClient) -> None:
    response = await client.get(
        "/api/health", headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 200
```

Run: `uv run pytest tests/test_csrf.py -v`
Expected: FAIL — первый тест получает 201 вместо 403.

- [ ] **Step 2: Реализация middleware**

`backend/app/core/csrf.py`:

```python
from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.settings import get_settings

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class OriginCheckMiddleware(BaseHTTPMiddleware):
    """Защита от CSRF: изменяющие запросы принимаются только со своего origin.

    Браузер не позволяет чужому сайту подделать заголовок Origin, поэтому
    сравнение netloc из Origin с Host отсекает cross-site запросы; запросы
    без Origin (curl, тесты, same-origin навигация) пропускаются.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        origin = request.headers.get("origin")
        if request.method in UNSAFE_METHODS and origin is not None:
            host = request.headers.get("host", "")
            if urlparse(origin).netloc != host and origin not in get_settings().allowed_origins:
                return JSONResponse(
                    {"detail": "Запрос с чужого origin отклонён"}, status_code=403
                )
        return await call_next(request)
```

В `backend/app/main.py` после создания `app` добавить:

```python
from app.core.csrf import OriginCheckMiddleware

app.add_middleware(OriginCheckMiddleware)
```

(импорт — в блок импортов сверху, вызов — сразу после `app = FastAPI(...)`).

- [ ] **Step 3: Тесты зелёные, линт, коммит**

Run: `uv run pytest -v && uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: всё зелёное.

```bash
git add backend
git commit -m "Этап 1: CSRF-защита проверкой Origin для изменяющих запросов"
```

---

### Task 8: Приглашение участника в workspace

**Files:**
- Modify: `backend/app/identity/router.py`
- Test: `backend/tests/test_members_api.py`

- [ ] **Step 1: Падающие тесты**

`backend/tests/test_members_api.py`:

```python
from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _register_and_get_workspace_id(client: AsyncClient, creds: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    workspace_id: str = me.json()["workspaces"][0]["id"]
    return workspace_id


async def test_owner_invites_existing_user(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=BOB)
    client.cookies.clear()
    workspace_id = await _register_and_get_workspace_id(client, ALICE)

    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]}
    )
    assert response.status_code == 201
    assert response.json()["role"] == "member"

    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)
    me = await client.get("/api/me")
    roles = {ws["role"] for ws in me.json()["workspaces"]}
    assert roles == {"owner", "member"}


async def test_member_cannot_invite(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=BOB)
    client.cookies.clear()
    workspace_id = await _register_and_get_workspace_id(client, ALICE)
    await client.post(f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]})

    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)
    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": ALICE["email"]}
    )
    assert response.status_code == 403


async def test_invite_unknown_email_not_found(client: AsyncClient) -> None:
    workspace_id = await _register_and_get_workspace_id(client, ALICE)
    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": "ghost@example.com"}
    )
    assert response.status_code == 404


async def test_invite_twice_conflict(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=BOB)
    client.cookies.clear()
    workspace_id = await _register_and_get_workspace_id(client, ALICE)
    await client.post(f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]})
    response = await client.post(
        f"/api/workspaces/{workspace_id}/members", json={"email": BOB["email"]}
    )
    assert response.status_code == 409
```

Run: `uv run pytest tests/test_members_api.py -v`
Expected: FAIL — 404, роута нет.

- [ ] **Step 2: Эндпоинт**

Добавить в `backend/app/identity/router.py` (импорты `uuid`, `MemberIn`, `require_owner` — в соответствующие блоки):

```python
@router.post("/workspaces/{workspace_id}/members", status_code=201)
async def add_member(
    workspace_id: uuid.UUID,
    payload: MemberIn,
    _owner: Annotated[User, Depends(require_owner)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, str]:
    try:
        membership = await service.invite_member(db, workspace_id, payload.email)
    except LookupError:
        raise HTTPException(
            status_code=404, detail="Пользователь с таким email не найден"
        ) from None
    except service.AlreadyMemberError:
        raise HTTPException(status_code=409, detail="Уже участник") from None
    return {"user_id": str(membership.user_id), "role": membership.role}
```

- [ ] **Step 3: Тесты зелёные, линт, коммит**

Run: `uv run pytest -v && uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: всё зелёное.

```bash
git add backend
git commit -m "Этап 1: приглашение участника в workspace (owner-only)"
```

---

### Task 9: Compose и Dockerfile — healthchecks, миграции на старте

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/Dockerfile`

- [ ] **Step 1: Обновить docker-compose.yml**

Внести изменения (остальное не трогать):

```yaml
  postgres:
    # ... как было, добавить:
    ports:
      - "127.0.0.1:5432:5432"

  redis:
    image: redis:7
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  backend:
    # ... как было, environment дополнить:
    environment:
      DATABASE_URL: postgresql+asyncpg://aiccountant:${POSTGRES_PASSWORD}@postgres:5432/aiccountant
      REDIS_URL: redis://redis:6379/0
      COOKIE_SECURE: "true"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
```

Порты postgres/redis привязаны к 127.0.0.1 — для дев-режима без Docker
(`uv run uvicorn ... --reload` с локальной машины) и отладки; наружу
не публикуются.

- [ ] **Step 2: Обновить backend/Dockerfile**

Заменить целиком:

```dockerfile
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
CMD ["sh", "-c", "/app/.venv/bin/alembic upgrade head && exec /app/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000"]
```

- [ ] **Step 3: Живая проверка**

```bash
docker compose up -d --build
sleep 8
curl -k https://localhost/api/health
curl -k -X POST https://localhost/api/auth/register \
  -H "Content-Type: application/json" -c /tmp/cookies.txt \
  -d '{"email":"smoke@example.com","password":"password123"}'
curl -k -b /tmp/cookies.txt https://localhost/api/me
```

Expected: `{"status":"ok"}`; регистрация 201 с id/email; `/api/me` возвращает email и workspace «Домохозяйство» с ролью owner.

Логи миграций: `docker compose logs backend | head -20` — виден `alembic upgrade head`.

- [ ] **Step 4: Commit (стек оставить запущенным)**

```bash
git add docker-compose.yml backend/Dockerfile
git commit -m "Этап 1: healthchecks, локальные порты БД и миграции при старте контейнера"
```

---

### Task 10: Frontend — Mantine, роутинг, API-клиент, AuthGuard

**Files:**
- Modify: `frontend/package.json` (через pnpm add)
- Create: `frontend/postcss.config.cjs`
- Create: `frontend/src/test-setup.ts`
- Modify: `frontend/vite.config.ts`
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/auth.ts`
- Create: `frontend/src/AuthGuard.tsx`
- Modify: `frontend/src/main.tsx`
- Delete: `frontend/src/App.tsx`, `frontend/src/App.test.tsx`

- [ ] **Step 1: Зависимости**

```bash
cd frontend
pnpm add @mantine/core @mantine/hooks @mantine/form @tanstack/react-query react-router-dom
pnpm add -D postcss postcss-preset-mantine postcss-simple-vars @testing-library/user-event
```

- [ ] **Step 2: PostCSS и тестовое окружение**

`frontend/postcss.config.cjs`:

```js
module.exports = {
  plugins: {
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
  },
}
```

`frontend/src/test-setup.ts` (Mantine требует matchMedia/ResizeObserver, которых нет в jsdom):

```ts
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
```

В `frontend/vite.config.ts` строку `test:` заменить на:

```ts
  test: { environment: 'jsdom', setupFiles: ['src/test-setup.ts'] },
```

- [ ] **Step 3: API-клиент**

`frontend/src/api/client.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body?.detail ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}
```

`frontend/src/api/auth.ts`:

```ts
import { api } from './client'

export interface Workspace {
  id: string
  name: string
  role: string
}

export interface Me {
  id: string
  email: string
  workspaces: Workspace[]
}

export interface UserOut {
  id: string
  email: string
}

export const getMe = () => api<Me>('/api/me')

export const login = (email: string, password: string) =>
  api<UserOut>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })

export const register = (email: string, password: string) =>
  api<UserOut>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) })

export const logout = () => api<void>('/api/auth/logout', { method: 'POST' })
```

- [ ] **Step 4: AuthGuard и роутинг**

`frontend/src/AuthGuard.tsx`:

```tsx
import { Center, Loader } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { getMe } from './api/auth'

export function AuthGuard({ children }: { children: ReactNode }) {
  const { isPending, isError } = useQuery({ queryKey: ['me'], queryFn: getMe })
  if (isPending)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  if (isError) return <Navigate to="/login" replace />
  return <>{children}</>
}
```

Заменить `frontend/src/main.tsx` целиком (страницы появятся в задаче 11 — этот шаг завершается вместе с ней; порядок: сначала создать файлы страниц из задачи 11, либо выполнить задачи 10–11 в одной ветке правок и проверять совместно):

```tsx
import '@mantine/core/styles.css'
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AuthGuard } from './AuthGuard'
import './index.css'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    path: '/',
    element: (
      <AuthGuard>
        <HomePage />
      </AuthGuard>
    ),
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
)
```

Удалить `frontend/src/App.tsx` и `frontend/src/App.test.tsx` (их заменяют страницы и их тесты из задачи 11). Коммит — общий в конце задачи 11.

---

### Task 11: Frontend — страницы Login/Register/Home, тесты, финал

**Files:**
- Create: `frontend/src/pages/LoginPage.tsx`
- Create: `frontend/src/pages/RegisterPage.tsx`
- Create: `frontend/src/pages/HomePage.tsx`
- Test: `frontend/src/pages/LoginPage.test.tsx`

- [ ] **Step 1: Страницы**

`frontend/src/pages/LoginPage.tsx`:

```tsx
import {
  Alert,
  Anchor,
  Button,
  Container,
  Paper,
  PasswordInput,
  TextInput,
  Title,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { login } from '../api/auth'
import { ApiError } from '../api/client'

export function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+$/.test(v) ? null : 'Некорректный email'),
      password: (v) => (v.length > 0 ? null : 'Введите пароль'),
    },
  })
  const mutation = useMutation({
    mutationFn: (values: { email: string; password: string }) =>
      login(values.email, values.password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate('/')
    },
  })

  return (
    <Container size={420} my={80}>
      <Title ta="center">AIccountant</Title>
      <Paper withBorder shadow="sm" p="lg" mt="lg" radius="md">
        <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
          <TextInput label="Email" placeholder="you@example.com" {...form.getInputProps('email')} />
          <PasswordInput label="Пароль" mt="md" {...form.getInputProps('password')} />
          {mutation.isError && (
            <Alert color="red" mt="md">
              {mutation.error instanceof ApiError && mutation.error.status === 401
                ? 'Неверный email или пароль'
                : 'Не удалось войти, попробуйте ещё раз'}
            </Alert>
          )}
          <Button type="submit" fullWidth mt="xl" loading={mutation.isPending}>
            Войти
          </Button>
        </form>
        <Anchor component={Link} to="/register" size="sm" mt="md" display="block" ta="center">
          Нет аккаунта? Зарегистрироваться
        </Anchor>
      </Paper>
    </Container>
  )
}
```

`frontend/src/pages/RegisterPage.tsx`:

```tsx
import {
  Alert,
  Anchor,
  Button,
  Container,
  Paper,
  PasswordInput,
  TextInput,
  Title,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { register } from '../api/auth'
import { ApiError } from '../api/client'

export function RegisterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+$/.test(v) ? null : 'Некорректный email'),
      password: (v) => (v.length >= 8 ? null : 'Минимум 8 символов'),
    },
  })
  const mutation = useMutation({
    mutationFn: (values: { email: string; password: string }) =>
      register(values.email, values.password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate('/')
    },
  })

  return (
    <Container size={420} my={80}>
      <Title ta="center">Регистрация</Title>
      <Paper withBorder shadow="sm" p="lg" mt="lg" radius="md">
        <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
          <TextInput label="Email" placeholder="you@example.com" {...form.getInputProps('email')} />
          <PasswordInput
            label="Пароль"
            description="Минимум 8 символов"
            mt="md"
            {...form.getInputProps('password')}
          />
          {mutation.isError && (
            <Alert color="red" mt="md">
              {mutation.error instanceof ApiError && mutation.error.status === 409
                ? 'Такой email уже зарегистрирован'
                : 'Не удалось зарегистрироваться, попробуйте ещё раз'}
            </Alert>
          )}
          <Button type="submit" fullWidth mt="xl" loading={mutation.isPending}>
            Создать аккаунт
          </Button>
        </form>
        <Anchor component={Link} to="/login" size="sm" mt="md" display="block" ta="center">
          Уже есть аккаунт? Войти
        </Anchor>
      </Paper>
    </Container>
  )
}
```

`frontend/src/pages/HomePage.tsx`:

```tsx
import { Button, Card, Container, Group, Text, Title } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getMe, logout } from '../api/auth'

export function HomePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe })
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear()
      navigate('/login')
    },
  })

  return (
    <Container size="md" mt="xl">
      <Group justify="space-between">
        <Title>AIccountant</Title>
        <Group>
          <Text c="dimmed">{me?.email}</Text>
          <Button
            variant="light"
            onClick={() => logoutMutation.mutate()}
            loading={logoutMutation.isPending}
          >
            Выйти
          </Button>
        </Group>
      </Group>
      {me?.workspaces.map((ws) => (
        <Card key={ws.id} withBorder mt="lg">
          <Text fw={500}>{ws.name}</Text>
          <Text size="sm" c="dimmed">
            Ваша роль: {ws.role === 'owner' ? 'владелец' : 'участник'}
          </Text>
        </Card>
      ))}
    </Container>
  )
}
```

- [ ] **Step 2: Тест страницы входа**

`frontend/src/pages/LoginPage.test.tsx`:

```tsx
import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, test } from 'vitest'
import { LoginPage } from './LoginPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

test('рендерит форму входа', () => {
  renderPage()
  expect(screen.getByLabelText('Email')).toBeDefined()
  expect(screen.getByLabelText('Пароль')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Войти' })).toBeDefined()
})

test('показывает ошибки валидации при пустой отправке', async () => {
  renderPage()
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  expect(await screen.findByText('Некорректный email')).toBeDefined()
  expect(screen.getByText('Введите пароль')).toBeDefined()
})
```

- [ ] **Step 3: Тесты, линт, сборка**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: все тесты зелёные, линт чистый, сборка успешна.

- [ ] **Step 4: Живая проверка в Docker**

```bash
docker compose up -d --build
```

В браузере: `https://localhost` → редирект на форму входа; регистрация нового
пользователя → главная с workspace «Домохозяйство» и ролью «владелец»;
выход → снова форма входа; вход по паролю работает.

- [ ] **Step 5: Commit (задачи 10 и 11 вместе)**

```bash
git add -A frontend
git commit -m "Этап 1: страницы входа и регистрации на Mantine, AuthGuard, главная"
```

---

### Task 12: Финал — полный прогон и PR

- [ ] **Step 1: Полный прогон обеих половин**

```bash
cd backend && uv run pytest -v && uv run ruff check . && uv run ruff format --check . && uv run mypy
cd ../frontend && pnpm test && pnpm lint && pnpm build
```

Expected: всё зелёное.

- [ ] **Step 2: Push и PR**

```bash
git push -u origin etap-1-identity
gh pr create --base main --title "Этап 1.1: identity — auth, workspace, роли" --body "$(cat <<'EOF'
## Что сделано

- Фундамент БД: SQLAlchemy 2 (async) + Alembic, миграции применяются при старте контейнера
- Auth: регистрация/вход/выход по email+паролю (argon2), server-side сессии в Redis, httpOnly cookie, CSRF-проверка Origin
- Workspace «Домохозяйство» с ролями owner/member, приглашение участника по email
- Frontend: Mantine + react-router + TanStack Query, страницы входа/регистрации, AuthGuard, главная со списком workspace
- Мелкие доработки из ревью этапа 0: удалены мёртвые ассеты, title/lang, README фронта, healthchecks и depends_on в compose

## Проверено

- pytest с testcontainers (postgres + redis): миграции, security, сессии, auth API, CSRF, приглашения
- vitest: форма входа и её валидация; oxlint и сборка чистые
- Вживую в Docker: регистрация → главная → выход → вход через https://localhost
EOF
)"
```

Дождаться зелёного CI: `gh pr checks <номер> --watch`.
PR не мержить — решение за координатором после ревью.

---

## Definition of done

- Зарегистрироваться, войти, выйти и увидеть свой workspace можно через UI на `https://localhost`.
- Владелец может пригласить зарегистрированного пользователя, тот видит общий workspace.
- Сессии живут в Redis, cookie httpOnly+Secure (в Docker), CSRF-проверка Origin активна.
- Миграции применяются автоматически при старте контейнера.
- Все тесты (pytest с testcontainers, vitest) и линтеры зелёные локально и в CI.

## Отложено сознательно (не делать в этом плане)

- Rate limiting логина — этап 3 (hardening) по спеке.
- import-linter контракт границ модулей — появится в плане 1.2 (ledger), когда будет второй домен и контракт станет осмысленным.
- Удаление аккаунта, смена пароля, восстановление — вне MVP-скоупа identity.
- request_id/workspace_id в structlog-контексте — план 1.2, вместе с первым доменным логированием.
- Непривилегированный USER в backend/Dockerfile — вместе с hardening этапа 3.
- Вынос configure_logging() из module-level в явные entrypoint'ы — при появлении Celery (план 1.3).
