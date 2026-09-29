# Десктопный клиент на Tauri — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** приложение Tauri для Windows, которое показывает нынешний React-интерфейс и собирает операции банков по кнопке, без CLI и терминала.

**Architecture:** ядро коллектора (TypeScript) работает в окне приложения и получает обвязки параметрами; Rust-оболочка даёт только то, чего окно не может: запрос к банку со списком разрешённых адресов, секреты в хранилище ОС, окно входа в банк с отдельным профилем. Бэкенд принимает серверную сессию заголовком `Session` и пускает origin приложения через CORS.

**Tech Stack:** Tauri 2.12 (Rust 1.98, reqwest 0.12 на rustls, keyring 3), React 19 + Vite + Mantine, FastAPI, vitest, pytest, cargo test.

Спека: `docs/superpowers/specs/2026-09-29-desktop-client-design.md` (дальше — «спека»).
Разведка: `docs/superpowers/specs/2026-09-29-desktop-shell-recon.md` (дальше — «разведка»).

---

## Правила исполнения

Прочитать до первой задачи. Они не пожелания: каждое оплачено в этом проекте.

- **Worktree и ветка** — `desktop/tauri-client` в `.claude/worktrees/desktop-recon`,
  от `origin/main`. Общий каталог репозитория и основной стенд не трогать.
- **Порядок в каждой задаче:** тест → красный прогон → реализация → зелёный
  прогон → **коммит** → внесение дефекта из задачи → красный прогон →
  `git checkout -- <файл>` → зелёный. Коммит **до** дефекта: иначе откат дефекта
  унесёт и правку (так уже было в этом проекте).
- **Документация — в той же задаче**, что и поведение (`CLAUDE.md`, «Справочник и
  документация»). Утверждение в справочнике пишется по строке кода, которую можно
  назвать, — с `файл:строка`.
- **Комментарии и коммиты — по-русски.** Без строк `Co-Authored-By`.
- **Деньги** — строки и `Decimal`, никогда не `float`, включая тесты.
- **В логи** — только идентификаторы и счётчики. Rust не пишет ни куки, ни тела
  запросов и ответов банка, ни адрес запроса к Т-Банку (в нём секрет сессии).
- **Перед слиянием** — `git fetch origin` и `git log --oneline HEAD..origin/main`
  (`CLAUDE.md`, «Слияние — через PR и от свежего `origin/main`»).

### Команды проверки (сверены 2026-09-29)

| Где | Команда | Каталог |
|---|---|---|
| бэкенд | `uv run ruff check .` · `uv run ruff format --check .` · `uv run mypy` · `uv run lint-imports` · `uv run pytest` | `backend/` |
| бэкенд, справочник | `uv run python scripts/gen_reference.py` | `backend/` |
| фронт | `pnpm lint` · `pnpm test` · `pnpm build` | `frontend/` |
| коллектор | `pnpm lint` · `pnpm test` · `pnpm build` · `pnpm reference` | `collector/` |
| оболочка | `cargo fmt --check` · `cargo clippy --all-targets -- -D warnings` · `cargo test` | `desktop/src-tauri/` |

`mypy` запускается **без аргументов**: CI проверяет и `tests/`, а `mypy app` — нет
(PR #40 упал именно на этом). Rust на машине владельца стоит в `~/.cargo/bin`,
который в PATH оболочки Git Bash не попадает: `export PATH="$HOME/.cargo/bin:$PATH"`.

### Факты, на которые опирается план (проверены, а не предположены)

- Фронт компилирует исходники коллектора своим `tsconfig.app.json`
  (`erasableSyntaxOnly`, `verbatimModuleSyntax`, без типов Node). Проба 2026-09-29
  показала ровно четыре препятствия: поле-параметр в конструкторе `BankHttpError`
  (`collector/src/http/allowlist-client.ts:14`), `node:https` в
  `collector/src/http/transport.ts`, `process`/`NodeJS` в
  `collector/src/runner/config.ts`, `node:crypto` в
  `collector/src/runner/fingerprint.ts`.
- Связка `"aiccountant-collector": "link:../collector"` в `frontend/package.json`
  работает: `tsc`, `vitest` и `vite build` фронта проходят с импортом
  `aiccountant-collector/src/...` (проба 2026-09-29).
- `sha256("tbank:acc-1")` = `451463f49a30812617cce38f3ed28ad994e99b423b94fb678d09ceb52d10daef`
  и через `node:crypto`, и через WebCrypto. Уже сделанные привязки счетов
  переход на WebCrypto переживают.
- В Tauri 2.12: окно открывается с `about:blank`; `delete_cookie` стирает
  HttpOnly-куку; `url()` видит адрес после `history.pushState` (проба 2026-09-29).
- `WebviewWindowBuilder::build`, `cookies_for_url` и `cookies` на Windows
  **зависают в синхронной команде** (`tauri-2.12.0/src/webview/webview_window.rs:58,115,2732`).
  Все команды окна банка — `async`.
- Разрешение на команду приложения называется `allow-<команда>` с дефисами
  вместо подчёркиваний (`tauri-utils-2.10.0/src/acl/build.rs:290`):
  `bank_request` → `allow-bank-request`.
- `www.tbank.ru` 2026-09-29 отдаёт цепочку от корня Минцифры; с системным
  набором к нему не подключаются ни Node, ни reqwest (спека, §3.1).

---

## Карта файлов

**Бэкенд**

| Файл | Что меняется |
|---|---|
| `backend/app/identity/deps.py` | схема `Session` в `get_current_user`; разбор заголовка — функция `session_from_header` |
| `backend/app/identity/router.py` | `login`/`register` отдают токен при `client="app"`; `logout` принимает `Session` |
| `backend/app/identity/schemas.py` | `client` во входе и регистрации, `session_token` в ответе |
| `backend/app/core/settings.py` | origin приложения в `allowed_origins` по умолчанию |
| `backend/app/main.py` | `CORSMiddleware` по `allowed_origins` |
| `backend/tests/test_app_session.py` | новый: сессия приложения |
| `docs/reference/identity.md` | вход приложения, схема `Session`, CORS |

**Коллектор**

| Файл | Что меняется |
|---|---|
| `collector/src/http/allowlist-client.ts` | `BankHttpError` без поля-параметра |
| `collector/src/http/transport.ts` | только интерфейс и `fetchTransport` |
| `collector/src/runner/https-transport.ts` | новый: `httpsTransport`, переехал из `transport.ts` (живёт до удаления CLI) |
| `collector/src/plugins/{tbank,sber,alfa}/client.ts`, `index.ts` | транспорт обязателен и приходит снаружи, `ca` уходит |
| `collector/src/plugins/registry.ts` | `pluginFor(name, { transport })` |
| `collector/src/plugins/tbank/login.ts` | ожидание живой сессии опросом `isAlive` |
| `collector/src/core/contract.ts` | `BrowserSession.waitForRequest` удаляется |
| `collector/src/collect/app-connection.ts` | новый: `AppConnection` |
| `collector/src/collect/{app-api,push,discovered,fingerprint,report}.ts` | переехали из `runner/`, берут `AppConnection` |
| `collector/src/collect/credentials-codec.ts` | новый: `parseCredentials`/`serializeCredentials` из `runner/secret-store.ts` |
| `collector/src/collect/collect-bank.ts` | новый: сценарий сбора одного банка |
| `collector/src/runner/*` | CLI до задачи 21 живёт на новых сигнатурах, в задаче 21 удаляется |

**Оболочка** — новый каталог `desktop/`

| Файл | Ответственность |
|---|---|
| `desktop/package.json` | `@tauri-apps/cli`, скрипт `tauri` |
| `desktop/src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json` | сборка, манифест команд, окно `main` |
| `desktop/src-tauri/capabilities/default.json` | команды разрешены только окну `main` |
| `desktop/src-tauri/russian_trusted_root_ca.pem` | корень УЦ Минцифры |
| `desktop/src-tauri/src/banks.rs` | банки: хост API, домен входа, список адресов, доверие |
| `desktop/src-tauri/src/http.rs` | команда `bank_request` |
| `desktop/src-tauri/src/secrets.rs` | команды `secret_session_*`, `app_token_*` |
| `desktop/src-tauri/src/windows.rs` | команды `bank_window_*`, `bank_forget` |
| `desktop/src-tauri/src/lib.rs`, `main.rs` | сборка приложения |

**Фронт**

| Файл | Ответственность |
|---|---|
| `frontend/src/desktop/runtime.ts` | `isDesktop()`, `invoke` |
| `frontend/src/desktop/connection.ts` | адрес сервера и токен приложения |
| `frontend/src/api/client.ts` | `apiFetch`: один путь запроса для браузера и приложения |
| `frontend/src/api/auth.ts`, `api/imports.ts` | вход приложения; загрузка файла через `apiFetch` |
| `frontend/src/desktop/bank-transport.ts` | `Transport` поверх `bank_request` |
| `frontend/src/desktop/bank-window.ts` | `LoginPrompt`/`BrowserSession` поверх `bank_window_*` |
| `frontend/src/desktop/collector-host.ts` | сборка `CollectHost` для банка |
| `frontend/src/pages/LoginPage.tsx` | поле «Адрес сервера» в приложении |
| `frontend/src/pages/BanksPage.tsx` | экран «Банки» |
| `frontend/src/main.tsx`, `AppLayout.tsx` | маршрут и пункт меню «Банки» только в приложении |

---

## Этап A. Бэкенд: сессия приложения

### Задача 1: схема `Session` в заголовке

Приложение не держит cookie: серверную сессию оно предъявляет заголовком
`Authorization: Session <токен>`. Схема `Bearer` по-прежнему означает API-токен.
`require_session_user` (`backend/app/identity/deps.py`) уже различает их по
`token_scope`: сессия этого поля не выставляет, поэтому менять его не нужно —
тест это закрепляет.

**Files:**
- Modify: `backend/app/identity/deps.py`
- Modify: `backend/app/identity/router.py` (ручка `logout`)
- Create: `backend/tests/test_app_session.py`
- Modify: `docs/reference/identity.md` (раздел «Заголовок против куки»)

- [ ] **Step 1: тесты**

```python
# backend/tests/test_app_session.py
from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}


async def _session_token(client: AsyncClient) -> str:
    """Сессия, выданная браузеру, — тот же токен, что приложение получит в ответе."""
    await client.post("/api/auth/register", json=ALICE)
    token = client.cookies["session"]
    client.cookies.clear()
    return token


async def test_session_header_authorizes(client: AsyncClient) -> None:
    token = await _session_token(client)
    resp = await client.get("/api/me", headers={"Authorization": f"Session {token}"})
    assert resp.status_code == 200
    assert resp.json()["email"] == ALICE["email"]


async def test_unknown_session_rejected(client: AsyncClient) -> None:
    resp = await client.get("/api/me", headers={"Authorization": "Session не-сессия"})
    assert resp.status_code == 401


async def test_empty_session_rejected(client: AsyncClient) -> None:
    resp = await client.get("/api/me", headers={"Authorization": "Session "})
    assert resp.status_code == 401


async def test_session_header_is_a_person_not_a_token(client: AsyncClient) -> None:
    """Сессия приложения — человек, а не машинный токен: ей доступно то, что
    require_session_user запрещает токенам (выпуск токена — одно из таких)."""
    token = await _session_token(client)
    headers = {"Authorization": f"Session {token}"}
    ws = (await client.get("/api/me", headers=headers)).json()["workspaces"][0]["id"]
    resp = await client.post(
        "/api/tokens", params={"workspace_id": ws}, json={"name": "к"}, headers=headers
    )
    assert resp.status_code == 201


async def test_logout_with_session_header_ends_that_session(client: AsyncClient) -> None:
    token = await _session_token(client)
    headers = {"Authorization": f"Session {token}"}
    assert (await client.post("/api/auth/logout", headers=headers)).status_code == 204
    assert (await client.get("/api/me", headers=headers)).status_code == 401
```

- [ ] **Step 2: красный прогон**

Run (в `backend/`): `uv run pytest tests/test_app_session.py -q`
Expected: FAIL — запросы с `Session` получают 401 «Неверный токен»; `test_unknown_session_rejected` и `test_empty_session_rejected` зелёные уже сейчас (это нормально: они стерегут, чтобы реализация их не сломала).

- [ ] **Step 3: реализация в `deps.py`**

Вынести поиск пользователя по сессии в функцию и добавить разбор схемы:

```python
def session_from_header(authorization: str | None) -> str | None:
    """Токен сессии из `Authorization: Session <токен>`; None — заголовок не про
    сессию. Нужен двоим: входу по заголовку и выходу, который обязан закрыть
    именно предъявленную сессию."""
    if authorization is None:
        return None
    scheme, _, raw = authorization.partition(" ")
    if scheme.lower() != "session" or not raw.strip():
        return None
    return raw.strip()


async def _user_by_session(db: AsyncSession, redis: Redis, token: str) -> User:
    user_id = await get_session_user_id(redis, token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Сессия истекла")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user
```

В `get_current_user` ветка `authorization is not None` начинается так, дальше —
прежний код `Bearer` без изменений; ветка cookie в конце зовёт `_user_by_session`:

```python
    if authorization is not None:
        # приложение (десктоп, телефон) предъявляет ту же серверную сессию, что
        # браузер держит в cookie: это человек, а не машинный токен, поэтому
        # token_workspace_id не выставляется и запреты для токенов его не касаются
        token = session_from_header(authorization)
        if token is not None:
            return await _user_by_session(db, redis, token)
        scheme, _, raw = authorization.partition(" ")
        if scheme.lower() != "bearer" or not raw.strip():
            raise HTTPException(status_code=401, detail="Неверный токен")
        # ... прежний код Bearer
    if session is None:
        raise HTTPException(status_code=401, detail="Не авторизован")
    return await _user_by_session(db, redis, session)
```

Пустая `Session ` даёт `None` из `session_from_header` и уходит в ветку «не
bearer» → 401.

- [ ] **Step 4: `logout` в `router.py`**

```python
@router.post("/auth/logout", status_code=204)
async def logout(
    response: Response,
    redis: Annotated[Redis, Depends(get_redis)],
    session: Annotated[str | None, Cookie()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    token = session_from_header(authorization) or session
    if token is not None:
        await sessions.delete_session(redis, token)
    response.delete_cookie(SESSION_COOKIE)
```

Импортировать `Header` из `fastapi` и `session_from_header` из `app.identity.deps`.

- [ ] **Step 5: зелёный прогон и проверки**

Run: `uv run pytest tests/test_app_session.py tests/test_auth_api.py tests/test_api_tokens.py -q`, затем `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run lint-imports`
Expected: всё зелёное.

- [ ] **Step 6: справочник**

`docs/reference/identity.md`, раздел «Заголовок против куки»: третий способ
предъявить себя — `Session <токен>`; это та же серверная сессия, что в cookie,
и запреты для токенов её не касаются. Ссылки `deps.py:<строка>` на
`session_from_header` и ветку в `get_current_user`, `router.py:<строка>` на `logout`.

- [ ] **Step 7: коммит**

```bash
git add backend/app/identity/deps.py backend/app/identity/router.py backend/tests/test_app_session.py docs/reference/identity.md
git commit -m "Сессия приложения заголовком Session: человек, а не машинный токен"
```

- [ ] **Step 8: проверка дефектом**

В ветке сессии `get_current_user` перед `return` добавить
`request.state.token_workspace_id = uuid.uuid4()`.
Run: `uv run pytest tests/test_app_session.py -q`
Expected: FAIL `test_session_header_is_a_person_not_a_token` (403).
`git checkout -- backend/app/identity/deps.py`, прогнать — зелёный.

---

### Задача 2: вход и регистрация отдают токен приложению

**Files:**
- Modify: `backend/app/identity/schemas.py`
- Modify: `backend/app/identity/router.py` (`register`, `login`, `_set_session_cookie`)
- Modify: `backend/tests/test_app_session.py`
- Modify: `docs/reference/identity.md` (рядом с «Сессия браузера» — «Сессия приложения»)

- [ ] **Step 1: тесты (дописать в `test_app_session.py`)**

```python
async def test_app_login_returns_token_not_cookie(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=ALICE)
    client.cookies.clear()

    resp = await client.post("/api/auth/login", json={**ALICE, "client": "app"})

    assert resp.status_code == 200
    token = resp.json()["session_token"]
    assert token
    assert "session" not in resp.cookies
    me = await client.get("/api/me", headers={"Authorization": f"Session {token}"})
    assert me.status_code == 200


async def test_browser_login_unchanged(client: AsyncClient) -> None:
    await client.post("/api/auth/register", json=ALICE)
    client.cookies.clear()

    resp = await client.post("/api/auth/login", json=ALICE)

    assert "session" in resp.cookies
    assert resp.json()["session_token"] is None


async def test_app_register_returns_token(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/register", json={**ALICE, "client": "app"})

    assert resp.status_code == 201
    assert resp.json()["session_token"]
    assert "session" not in resp.cookies


async def test_unknown_client_rejected(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/login", json={**ALICE, "client": "bot"})
    assert resp.status_code == 422
```

- [ ] **Step 2: красный прогон** — Expected: FAIL (`KeyError: 'session_token'`, 200 вместо 422).

- [ ] **Step 3: схемы (`schemas.py`)**

```python
from typing import Literal

# кто входит: браузер держит сессию в HttpOnly-cookie, приложение хранит её само
# в хранилище ОС и потому получает токен в ответе
Client = Literal["browser", "app"]


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    client: Client = "browser"


class LoginIn(BaseModel):
    email: EmailStr
    password: str
    client: Client = "browser"


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    # только для client="app"; браузеру токен в теле не отдаётся — ему хватает
    # cookie, недоступной скриптам страницы
    session_token: str | None = None
```

- [ ] **Step 4: роутер** — `_set_session_cookie` заменить на:

```python
def _issue_session(response: Response, token: str, client: Client) -> str | None:
    """Браузеру — cookie, приложению — токен в теле. Возвращает то, что уйдёт в
    session_token ответа."""
    if client == "app":
        return token
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_ttl_days * 24 * 60 * 60,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )
    return None
```

В `register` и `login`: `session_token = _issue_session(response, token, payload.client)`
и `return UserOut(id=user.id, email=user.email, session_token=session_token)`.
`Client` импортировать из `app.identity.schemas`.

- [ ] **Step 5: зелёный прогон** — `uv run pytest tests/test_app_session.py tests/test_auth_api.py tests/test_csrf.py -q` и `uv run mypy`.

- [ ] **Step 6: справочник** — «Сессия приложения»: признак `client`, токен в
теле, та же сессия и срок `session_ttl_days`; ссылки на `_issue_session` и `Client`.

- [ ] **Step 7: генерация и коммит**

Run: `uv run python scripts/gen_reference.py` — обновит `docs/reference/generated/api.md`.

```bash
git add backend/app/identity backend/tests/test_app_session.py docs/reference
git commit -m "Вход и регистрация отдают токен сессии приложению, браузеру — cookie"
```

- [ ] **Step 8: проверка дефектом** — в `_issue_session` заменить `"app"` на
`"browser"`. Expected: FAIL `test_app_login_returns_token_not_cookie`,
`test_browser_login_unchanged`. Откатить.

---

### Задача 3: CORS и origin приложения

Окно Tauri живёт на своём origin: `http://tauri.localhost` (Windows),
`tauri://localhost` (macOS, iOS), `http://localhost:5173` в разработке (Vite).
Запросы к серверу из него — cross-origin: нужен CORS, и проверка origin
(`backend/app/core/csrf.py`) должна пускать эти адреса.

**Files:**
- Modify: `backend/app/core/settings.py:14`
- Modify: `backend/app/main.py`
- Modify: `.env.example:3`
- Modify: `backend/tests/test_app_session.py`
- Modify: `docs/reference/identity.md` («Защита от CSRF»)

- [ ] **Step 1: тесты**

```python
TAURI_ORIGIN = "http://tauri.localhost"


async def test_preflight_from_app_allowed(client: AsyncClient) -> None:
    resp = await client.options(
        "/api/auth/login",
        headers={
            "Origin": TAURI_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == TAURI_ORIGIN


async def test_preflight_from_foreign_origin_not_allowed(client: AsyncClient) -> None:
    resp = await client.options(
        "/api/auth/login",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in resp.headers


async def test_app_origin_passes_origin_check(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/register",
        json={**ALICE, "client": "app"},
        headers={"Origin": TAURI_ORIGIN},
    )
    assert resp.status_code == 201
```

- [ ] **Step 2: красный прогон** — Expected: FAIL (405 на OPTIONS, 403 на регистрации).

- [ ] **Step 3: настройки**

```python
    # origin'ы, которым разрешены изменяющие запросы и CORS: dev-сервер Vite и
    # окно Tauri (http://tauri.localhost — Windows, tauri://localhost — macOS/iOS)
    allowed_origins: list[str] = [
        "http://localhost:5173",
        "http://tauri.localhost",
        "tauri://localhost",
    ]
```

- [ ] **Step 4: `main.py`** — после `app.add_middleware(LogContextMiddleware)`:

```python
# CORS добавляется последним и потому оборачивает остальные: отказ проверки
# origin тоже должен дойти до окна приложения читаемым ответом.
# allow_credentials=False намеренно: приложение не ходит с cookie, сессию оно
# предъявляет заголовком
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().allowed_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=False,
)
```

Импорты: `from fastapi.middleware.cors import CORSMiddleware`,
`from app.core.settings import get_settings`.

- [ ] **Step 5: `.env.example`** — пример значения дополнить обоими адресами Tauri.

- [ ] **Step 6: весь бэкенд** — все проверки из таблицы, включая `uv run pytest -q` (около 7 минут).

- [ ] **Step 7: справочник** — «Защита от CSRF»: CORS пускает те же origin'ы, что
и проверка; почему без credentials; ссылки на `main.py:<строка>`, `settings.py:<строка>`.

- [ ] **Step 8: коммит**

```bash
git add backend/app/core/settings.py backend/app/main.py .env.example backend/tests/test_app_session.py docs/reference/identity.md
git commit -m "CORS и проверка origin пускают окно приложения"
```

- [ ] **Step 9: проверка дефектом** — убрать `"http://tauri.localhost"` из
`allowed_origins`. Expected: FAIL `test_preflight_from_app_allowed`,
`test_app_origin_passes_origin_check`. Откатить.

---

## Этап B. Коллектор: ядро без Node

Цель этапа — ядро и плагины компилируются и работают в окне приложения. CLI
живёт до задачи 21 и на каждом шаге остаётся рабочим (`pnpm collect`), но уже
без разговора о счетах в терминале: привязка — только экран «Счета» (спека, §2).

### Задача 4: плагины без собственного транспорта

Сейчас плагины создают транспорт сами: Т-Банк — `fetch`, Сбер и Альфа —
`httpsTransport(ca)` на `node:https` (`collector/src/plugins/sber/client.ts:48`,
`alfa/client.ts:48`). В окне приложения прямой `fetch` к банку упрётся в CORS,
а `node:https` там нет вовсе, поэтому транспорт становится обязательным
параметром и приходит от оболочки для **всех трёх** банков.

Заодно: корень Минцифры нужен теперь и Т-Банку (спека, §3.1), поэтому CLI до
своего удаления ходит во все три банка через `httpsTransport` с этим корнем и
закрепляет ключ в окне входа у всех трёх.

**Files:**
- Modify: `collector/src/http/allowlist-client.ts:13-17` (`BankHttpError`)
- Modify: `collector/src/http/transport.ts` → оставить интерфейсы и `fetchTransport`
- Create: `collector/src/runner/https-transport.ts` ← `httpsTransport` и `abortError` из `transport.ts`
- Move tests: из `collector/src/http/transport.test.ts` и `allowlist-client.test.ts` тесты `httpsTransport` → `collector/src/runner/https-transport.test.ts`
- Modify: `collector/src/plugins/{tbank,sber,alfa}/client.ts`, `index.ts`
- Modify: `collector/src/plugins/registry.ts`, `registry.test.ts`
- Modify: `collector/src/runner/main.ts` (создание плагина)

- [ ] **Step 1: `BankHttpError` без поля-параметра** — фронт собирается с
`erasableSyntaxOnly`, и `constructor(readonly status: number)` там ошибка TS1294:

```ts
export class BankHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Банк ответил ${status}`)
    this.status = status
  }
}
```

- [ ] **Step 2: разделить транспорт.** В `http/transport.ts` остаются
`HttpResponse`, `SendOptions`, `Transport`, `fetchTransport`. `httpsTransport`
вместе с `abortError` и комментариями — в `runner/https-transport.ts` дословно
(импорт `Transport`, `HttpResponse` — из `../http/transport`). Тесты
`httpsTransport` переезжают в `runner/https-transport.test.ts` с теми же
именами; импорты в них поправить. `runner/` — код CLI, он живёт до задачи 21.

- [ ] **Step 3: тесты реестра** — `registry.test.ts` переписать на новую
зависимость (`loadCa` уходит):

```ts
import { expect, test, vi } from 'vitest'
import { fetchTransport, type Transport } from '../http/transport'
import { BANK_NAMES, pluginFor } from './registry'

function anyTransport(): Transport {
  return fetchTransport(vi.fn(async () => new Response('{}')) as unknown as typeof fetch)
}

test('плагин находится по имени банка', async () => {
  const plugin = await pluginFor('tbank', { transport: async () => anyTransport() })
  expect(plugin.name).toBe('tbank')
})

test('незнакомое имя банка — понятная ошибка со списком известных, транспорт не запрошен', async () => {
  const transport = vi.fn(async () => anyTransport())
  await expect(pluginFor('unknown-bank', { transport })).rejects.toThrowError(/unknown-bank.*tbank/)
  expect(transport).not.toHaveBeenCalled()
})

test('имя из прототипа объекта — та же понятная ошибка', async () => {
  const deps = { transport: async () => anyTransport() }
  await expect(pluginFor('toString', deps)).rejects.toThrowError(/toString/)
  await expect(pluginFor('constructor', deps)).rejects.toThrowError(/constructor/)
})

test('транспорт запрашивается ровно для своего банка и ровно один раз', async () => {
  for (const name of BANK_NAMES) {
    const transport = vi.fn(async () => anyTransport())
    const plugin = await pluginFor(name, { transport })
    expect(plugin.name).toBe(name)
    expect(transport.mock.calls).toEqual([[name]])
  }
})
```

Остальные тесты реестра, проверявшие ленивую загрузку корня, удалить: корень
больше не забота реестра.

- [ ] **Step 4: красный прогон** — `pnpm test src/plugins/registry.test.ts` (в `collector/`). Expected: FAIL (нет `transport` в зависимостях).

- [ ] **Step 5: реестр**

```ts
import type { BankPlugin } from '../core/contract'
import type { Transport } from '../http/transport'
import { createAlfaPlugin } from './alfa'
import { createSberPlugin } from './sber'
import { createTBankPlugin } from './tbank'

export interface RegistryDeps {
  /**
   * Транспорт к банку даёт оболочка. В приложении запрос уходит через Rust, где
   * стоят список разрешённых адресов и доверие к УЦ Минцифры; у CLI — через
   * node:https с тем же корнем. Плагин сам транспорт не выбирает: в окне
   * приложения прямой fetch к банку упёрся бы в CORS.
   */
  transport: (bank: string) => Promise<Transport>
}

// Реестр намеренно плоский и явный: список банков виден целиком, без
// автозагрузки каталогов и магии по именам файлов. Выбор через if/else, а не
// через объект-словарь: имя банка нигде не становится ключом доступа, и имена
// из Object.prototype просто ни с чем не совпадают
export const BANK_NAMES: readonly string[] = ['tbank', 'sber', 'alfa']

export async function pluginFor(name: string, deps: RegistryDeps): Promise<BankPlugin> {
  if (name === 'tbank') return createTBankPlugin({ transport: await deps.transport(name) })
  if (name === 'sber') return createSberPlugin({ transport: await deps.transport(name) })
  if (name === 'alfa') return createAlfaPlugin({ transport: await deps.transport(name) })
  throw new Error(`Неизвестный банк "${name}". Известные: ${BANK_NAMES.join(', ')}`)
}
```

- [ ] **Step 6: плагины.**
  - `tbank/client.ts`: `CreateOptions` → `{ transport: Transport; timeoutMs?: number }`
    (транспорт обязателен).
  - `tbank/index.ts`: константа `tbankPlugin` становится фабрикой
    `createTBankPlugin({ transport, timeoutMs })`; `clientFor` и проверка
    живости токена в `login` создают клиента с этим транспортом.
  - `sber/client.ts`, `alfa/client.ts`: из `CreateOptions` уходит `ca`,
    `transport` обязателен, импорт `httpsTransport` удалить, комментарий про
    «корень заменяет системный набор» перенести в `runner/https-transport.ts`
    (там он теперь правда).
  - `sber/index.ts`, `alfa/index.ts`: `PluginOptions` → `{ transport: Transport; timeoutMs?: number }`.
  - Тесты плагинов, которые создавали клиента или плагин без транспорта или с
    `ca`, передают `fetchTransport(fakeFetch)` — так уже сделано в
    `tbank/index.test.ts:20`.

- [ ] **Step 7: CLI.** В `runner/main.ts`:

```ts
// Т-Банк 2026-09-29 отдал цепочку от корня Минцифры (спека десктопного клиента,
// §3.1), поэтому до своего удаления CLI ходит во все три банка через этот корень
// и закрепляет его ключ в окне входа у всех трёх
const transport = httpsTransport(await loadTrustAnchor(CA_CACHE))
const plugin = await pluginFor(config.bank, { transport: async () => transport })
const pinnedSpki = ROOT_SPKI_SHA256
```

Прежняя переменная `pinnedSpki`, выставлявшаяся из `loadCa`, уходит.

- [ ] **Step 8: зелёный прогон** — `pnpm test && pnpm lint && pnpm build` в `collector/`. Expected: всё зелёное.

- [ ] **Step 9: проба фронтом** — убедиться, что ядро без Node:

```bash
cd frontend
printf "import { pluginFor } from '../../collector/src/plugins/registry'\nexport const probe = pluginFor\n" > src/__probe.ts
npx tsc -p tsconfig.app.json --noEmit
rm src/__probe.ts
```

Expected: ни одной ошибки из `collector/src/plugins` и `collector/src/http`.

- [ ] **Step 10: коммит**

```bash
git add collector
git commit -m "Плагины банков получают транспорт снаружи: в окне приложения его даёт оболочка"
```

- [ ] **Step 11: проверка дефектом** — в `pluginFor` для `sber` передать
`await deps.transport('tbank')`. Expected: FAIL «транспорт запрашивается ровно
для своего банка». Откатить.

---

### Задача 5: модуль `collect/` — связь с приложением без Node

Файлы, которые нужны приложению, переезжают из `runner/` (CLI) в `collect/`
(общее ядро) и перестают зависеть от переменных окружения. Разговор о счетах в
терминале удаляется: привязка — только экран «Счета» (спека, §2); CLI при
непривязанных счетах печатает их число и ссылку на экран, как сейчас без
терминала.

**Files:**
- Move (`git mv`, вместе с тестами): `runner/app-api.ts`, `runner/push.ts`,
  `runner/discovered.ts`, `runner/fingerprint.ts`, `runner/report.ts` → `collect/`
- Create: `collector/src/collect/app-connection.ts`
- Create: `collector/src/collect/credentials-codec.ts` (+ тест) ← `parseCredentials`,
  `serializeCredentials` из `runner/secret-store.ts` (и их тесты из `secret-store.test.ts`)
- Delete: `runner/link-prompt.ts`, `runner/declined.ts`, `runner/app-accounts.ts` и их тесты
- Modify: `runner/main.ts`, `runner/config.ts` (функция перехода конфига в `AppConnection`)
- Modify: `collector/.oxlintrc.json` — исключение для `fetch` переезжает на `src/collect/app-api.ts`

- [ ] **Step 1: `AppConnection`**

```ts
// collector/src/collect/app-connection.ts

/**
 * Куда и как коллектор ходит в наше приложение. Приложение предъявляет сессию
 * человека (`Session …`), CLI — API-токен (`Bearer …`); ядру разница не видна.
 */
export interface AppConnection {
  /** Адрес сервера приложения, например http://localhost:18000 */
  baseUrl: string
  workspaceId: string
  /** Значение заголовка Authorization целиком. */
  authorization: string
}
```

- [ ] **Step 2: `app-api.ts` на `AppConnection` и с кодом ответа в ошибке**

`appRequest(connection: AppConnection, request, fetchImpl?)`: `new URL(path, connection.baseUrl)`,
`workspace_id` из `connection.workspaceId`, заголовок `Authorization: connection.authorization`.
Ошибку бросать классом со статусом — без него сбор не отличит «сессия
приложения кончилась» (всё остановить, показать вход) от отказа по одному счёту:

```ts
/** Приложение ответило не успехом. Статус — полем, а не текстом: по нему решают. */
export class AppHttpError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(`Приложение ответило ${status}${detail}`)
    this.status = status
  }
}
```

`throw new AppHttpError(res.status, await describeFailure(res))`. Тест в
`collect/app-api.test.ts`: на ответ 401 бросается `AppHttpError` со `status === 401`,
текст прежний.

`push.ts`, `discovered.ts` — первый параметр `connection: AppConnection` вместо
`config: CollectorConfig`; тесты передают
`{ baseUrl: 'http://app.local', workspaceId: 'ws-1', authorization: 'Bearer secret-token' }`
и проверяют заголовок `Authorization` целиком.

- [ ] **Step 3: отпечаток на WebCrypto.** `node:crypto` в окне нет; WebCrypto
есть и в браузере, и в Node 24 (глобальный `crypto.subtle`). Функция становится
асинхронной. Тест-вектор держит совместимость с уже сделанными привязками:

```ts
// collect/fingerprint.test.ts — добавить
test('отпечаток совпадает с прежним node:crypto: уже сделанные привязки переживают переезд', async () => {
  expect(await accountFingerprint('tbank', 'acc-1')).toBe(
    '451463f49a30812617cce38f3ed28ad994e99b423b94fb678d09ceb52d10daef',
  )
  expect(await accountFingerprint('alfa', '40817810099910004312')).toBe(
    '59122fee16a684b2269500a8cd983a492eed3779fc574a528c101f945bac2014',
  )
})
```

Остальные тесты файла — `await` перед вызовом.

```ts
export async function accountFingerprint(bank: string, accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${bank}:${accountId}`))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
```

Докстрока функции остаётся прежней по смыслу. `syncDiscovered` строит
отпечатки через `await Promise.all(...)`.

- [ ] **Step 4: кодек секрета.** `parseCredentials` и `serializeCredentials`
переезжают дословно (вместе с докстрокой про «непригодная запись — это
„секрета нет“») в `collect/credentials-codec.ts`; `runner/secret-store.ts`
импортирует их оттуда. Тесты — в `collect/credentials-codec.test.ts`.

- [ ] **Step 5: CLI.** В `runner/config.ts` добавить:

```ts
export function appConnection(config: CollectorConfig): AppConnection {
  return { baseUrl: config.apiBaseUrl, workspaceId: config.workspaceId, authorization: `Bearer ${config.apiToken}` }
}
```

`runner/main.ts`: разговор о счетах (`decideCandidates`, `conductLinkPrompt`,
`readDeclined`, `rememberDeclined`) удалить; после `syncDiscovered` печатать
`В банке ещё ${accountsWord(n)} не ведётся. Привяжите их на экране «Счета».`, если
непривязанные есть. Удалить `link-prompt.ts`, `declined.ts`, `app-accounts.ts` с
тестами. `collector/README.md`, раздел «Привязка счетов» — убрать разговор в
терминале, оставить экран «Счета».

- [ ] **Step 6: прогон** — `pnpm test && pnpm lint && pnpm build && pnpm reference` в `collector/`;
`git status docs/reference/generated` — пусто. Проба фронтом из задачи 4, шаг 9,
с импортом `../../collector/src/collect/discovered` — без ошибок.

- [ ] **Step 7: справочник** — `docs/reference/collector.md`, «Привязка счетов
банка»: разговора в терминале больше нет; отпечаток — WebCrypto, значение то же
(ссылка на `collect/fingerprint.ts:<строка>` и тест-вектор).

- [ ] **Step 8: коммит**

```bash
git add -A collector docs/reference/collector.md
git commit -m "Связь коллектора с приложением — общий модуль collect/ без Node; разговор о счетах в терминале удалён"
```

- [ ] **Step 9: проверка дефектом** — в `accountFingerprint` поменять шаблон на
`` `${accountId}:${bank}` ``. Expected: FAIL тест-вектор. Откатить.

---

### Задача 6: счётчики итогов — числа, а не строки консоли

Экрану нужны числа, CLI — строки. Сейчас `collect/report.ts` печатает сразу в
консоль.

**Files:**
- Modify: `collector/src/collect/report.ts`, `report.test.ts`
- Create: `collector/src/runner/print-summary.ts` (появится в задаче 8; здесь CLI
  продолжает звать `reportCollected`)

- [ ] **Step 1: тесты** — к тестам счётчиков добавить чистую функцию:

```ts
test('счётчики считаются числами, без печати', () => {
  const log = vi.spyOn(console, 'log')
  const counters = countCollected([
    op({ kind: 'unknown' }),
    op({ kind: 'purchase', category_hint: null }),
    op({ kind: 'purchase', category_hint: 'groceries' }),
    op({ kind: 'income' }),
  ])
  expect(counters).toEqual({ unknownKinds: 1, missingHints: 1, purchases: 2, unrefinedIncome: 1 })
  expect(log).not.toHaveBeenCalled()
  log.mockRestore()
})
```

`op` — фабрика операции из этого же файла тестов; если она называется иначе,
взять ту, что есть (сверить `grep -n "function" collector/src/collect/report.test.ts`).

- [ ] **Step 2: реализация**

```ts
export interface CollectedCounters {
  /** Вид операции не распознан — банк прислал незнакомую группу. */
  unknownKinds: number
  /** Трат без подсказки о категории. */
  missingHints: number
  /** Всего трат — знаменатель для missingHints. */
  purchases: number
  /** Приходов, которые банк не дал разобрать подробнее. */
  unrefinedIncome: number
}

export function countCollected(operations: readonly CollectedOperation[]): CollectedCounters {
  const purchases = operations.filter((operation) => operation.kind === 'purchase')
  return {
    unknownKinds: operations.filter((operation) => operation.kind === 'unknown').length,
    missingHints: purchases.filter((operation) => operation.category_hint === null).length,
    purchases: purchases.length,
    unrefinedIncome: operations.filter((operation) => operation.kind === 'income').length,
  }
}
```

`reportUnknownKinds`, `reportMissingHints`, `reportUnrefinedIncome` считают через
`countCollected`; их тексты и комментарии о смысле каждого счётчика — без изменений.

- [ ] **Step 3: прогон, коммит**

```bash
git add collector/src/collect/report.ts collector/src/collect/report.test.ts
git commit -m "Счётчики итогов сбора — числами: экрану нужны числа, консоли — строки"
```

- [ ] **Step 4: проверка дефектом** — в `countCollected` считать `missingHints` по
всем операциям, а не по тратам. Expected: FAIL новый тест. Откатить.

---

### Задача 7: вход Т-Банка по живой сессии

В Tauri запросы страницы банка оболочке не видны, поэтому
`BrowserSession.waitForRequest` уходит из контракта. Доказательство входа
добывается напрямую: пока окно открыто, раз в 2 секунды читается кука `psid` и
проверяется `isTokenAlive` — тем же вызовом, которым оболочка проверяет сессию
перед сбором (спека, §3.2).

**Files:**
- Modify: `collector/src/plugins/tbank/login.ts`, `login.test.ts`
- Modify: `collector/src/core/contract.ts` (`BrowserSession`)
- Modify: `collector/src/runner/browser.ts` (`sessionOf` — удалить `waitForRequest`)
- Modify: `docs/reference/collector.md` (раздел о входе Т-Банка, если есть; иначе «Секреты»)

- [ ] **Step 1: тесты** — `login.test.ts` переписать под новый контракт.
Сессия-подделка без `waitForRequest`; часы подменяются, чтобы опрос шёл без
реального ожидания:

```ts
import { expect, test } from 'vitest'
import type { BrowserSession, LoginPrompt } from '../../core/contract'
import { obtainTBankToken, type LoginTiming } from './login'

const COOKIE = 'psid'

function fakeTiming(): LoginTiming & { waits: number[] } {
  let clock = 0
  const waits: number[] = []
  return {
    waits,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms)
      clock += ms
    },
  }
}

function session(cookie: { value: string | null }, onLogin?: () => void): BrowserSession {
  return {
    async goto() {},
    async clearCookie(name) {
      if (name === COOKIE) cookie.value = null
    },
    async cookies() {
      return cookie.value === null ? [] : [{ name: COOKIE, value: cookie.value }]
    },
    async waitForUrl() {
      onLogin?.()
    },
  }
}

function prompt(headless: BrowserSession, visible: BrowserSession): { prompt: LoginPrompt; opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    prompt: {
      async withBrowser(use, options) {
        const isHeadless = options?.headless ?? false
        opened.push(isHeadless ? 'headless' : 'visible')
        return use(isHeadless ? headless : visible)
      },
    },
  }
}

test('живая сессия в профиле — видимое окно не открывается', async () => {
  const cookie = { value: 'live' }
  const { prompt: p, opened } = prompt(session(cookie), session(cookie))
  const token = await obtainTBankToken(p, async (t) => t === 'live', fakeTiming())
  expect(token).toBe('live')
  expect(opened).toEqual(['headless'])
})

test('сессия оживает не сразу — ждём опросом, а не фиксированной паузой', async () => {
  const cookie = { value: 'warming' }
  let checks = 0
  const timing = fakeTiming()
  const { prompt: p } = prompt(session(cookie), session(cookie))
  const token = await obtainTBankToken(p, async () => ++checks >= 3, timing)
  expect(token).toBe('warming')
  expect(timing.waits).toEqual([2_000, 2_000])
})

test('фон не оживил сессию — видимый вход, мёртвая кука стёрта до перехода на вход', async () => {
  const cookie = { value: 'anonymous' }
  const visible = session(cookie, () => {
    cookie.value = 'fresh'
  })
  const { prompt: p, opened } = prompt(session(cookie), visible)
  const token = await obtainTBankToken(p, async (t) => t === 'fresh', fakeTiming())
  expect(token).toBe('fresh')
  expect(opened).toEqual(['headless', 'visible'])
})

test('вход выполнен, но сессия так и не ожила — ошибка, а не мёртвый токен', async () => {
  const cookie = { value: 'anonymous' }
  const { prompt: p } = prompt(session(cookie), session(cookie, () => {}))
  await expect(obtainTBankToken(p, async () => false, fakeTiming())).rejects.toThrow(/не ожила/)
})

test('банк недоступен — ошибка сразу, видимое окно не открывается', async () => {
  const cookie = { value: 'live' }
  const { prompt: p, opened } = prompt(session(cookie), session(cookie))
  await expect(
    obtainTBankToken(p, async () => { throw new Error('Банк недоступен (таймаут)') }, fakeTiming()),
  ).rejects.toThrow(/недоступен/)
  expect(opened).toEqual(['headless'])
})
```

Третий тест проверяет стирание куки косвенно: если `clearCookie` не вызван до
`waitForUrl`, в `cookie.value` к моменту опроса всё равно окажется `'fresh'` —
поэтому добавить в него отдельную проверку порядка: подделка видимой сессии
записывает вызовы в массив, и тест ожидает `['clearCookie', 'goto', 'waitForUrl']`
в начале.

- [ ] **Step 2: красный прогон** — `pnpm test src/plugins/tbank/login.test.ts`.
Expected: FAIL (нет `LoginTiming`, контракт требует `waitForRequest`).

- [ ] **Step 3: контракт.** Из `BrowserSession` (`core/contract.ts`) удалить
`waitForRequest`. Из `runner/browser.ts` — его реализацию в `sessionOf`.

- [ ] **Step 4: реализация `login.ts`.** Удалить `SESSION_PROBE_PATH`,
`isAuthorized`, `AUTHORIZED_REQUEST_TIMEOUT_MS` и прежние `refresh`/`logIn`;
добавить:

```ts
const POLL_INTERVAL_MS = 2_000
// после перехода в ЛК сессия оживает не сразу — кука уже есть, а банк отвечает
// SESSION_IS_ABSENT; минуты хватает с запасом
const LIVE_SESSION_TIMEOUT_MS = 60_000

/** Часы входа. Подменяются в тестах, чтобы опрос шёл без реального ожидания. */
export interface LoginTiming {
  now(): number
  wait(ms: number): Promise<void>
}

const REAL_TIMING: LoginTiming = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export async function obtainTBankToken(
  prompt: LoginPrompt,
  isTokenAlive: (token: string) => Promise<boolean>,
  timing: LoginTiming = REAL_TIMING,
): Promise<string> {
  const refreshed = await prompt.withBrowser(
    async (session) => {
      await session.goto(MYBANK_URL)
      return waitForLiveToken(session, isTokenAlive, timing, REFRESH_TIMEOUT_MS)
    },
    { headless: true },
  )
  if (refreshed !== null) return refreshed
  // окно входа — только видимое: человек вводит телефон и код сам, коллектор
  // в форму не вмешивается
  return prompt.withBrowser(async (session) => {
    // с протухшей кукой банк уводит со страницы входа обратно в ЛК, и мы бы
    // прочитали ровно тот же мёртвый токен
    await session.clearCookie(SESSION_COOKIE)
    await session.goto(LOGIN_URL)
    await session.waitForUrl((url) => url.href.startsWith(MYBANK_URL), LOGIN_TIMEOUT_MS)
    const token = await waitForLiveToken(session, isTokenAlive, timing, LIVE_SESSION_TIMEOUT_MS)
    if (token === null) throw new Error('Вход в Т-Банк выполнен, но сессия так и не ожила')
    return token
  })
}

/**
 * Доказательство входа — живая сессия, а не переход в ЛК и не наличие куки:
 * psid есть и у анонимной сессии. Недоступность банка (исключение из
 * isTokenAlive) не глотается: это не «сессии нет», и повторный вход её не лечит.
 */
async function waitForLiveToken(
  session: BrowserSession,
  isTokenAlive: (token: string) => Promise<boolean>,
  timing: LoginTiming,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = timing.now() + timeoutMs
  for (;;) {
    const token = await readToken(session)
    if (token !== null && (await isTokenAlive(token))) return token
    if (timing.now() >= deadline) return null
    await timing.wait(POLL_INTERVAL_MS)
  }
}
```

Докстроку над `obtainTBankToken` переписать: фон обновляет сессию по живому
профилю, видимое окно — только если фон не смог.

- [ ] **Step 5: зелёный прогон** — `pnpm test && pnpm lint && pnpm build` в `collector/`.

- [ ] **Step 6: справочник** — в `collector.md` то место, где описан вход Т-Банка
(найти `grep -n "psid\|waitForRequest\|авторизованн" docs/reference/collector.md`):
признак входа — живая сессия, проверяемая опросом; ссылка на `login.ts:<строка>`.

- [ ] **Step 7: коммит**

```bash
git add collector docs/reference/collector.md
git commit -m "Вход Т-Банка доказывается живой сессией, а не подслушанным запросом страницы"
```

- [ ] **Step 8: проверка дефектом** — в `waitForLiveToken` вернуть `token` без
проверки `isTokenAlive`. Expected: FAIL «вход выполнен, но сессия так и не
ожила» и «фон не оживил сессию». Откатить.

---

### Задача 8: `collectBank` — сценарий сбора одного банка

Сценарий из `runner/main.ts` становится функцией: обвязки приходят параметром,
итог — объектом для экрана (спека, §4). CLI переходит на неё и печатает итог сам.

**Files:**
- Create: `collector/src/collect/collect-bank.ts`, `collect-bank.test.ts`
- Create: `collector/src/runner/print-summary.ts`
- Create: `collector/src/app.ts` — вход для приложения
- Modify: `collector/src/runner/main.ts`
- Modify: `docs/reference/collector.md` («Что коллектор сообщает по итогам сбора»)

- [ ] **Step 1: тесты `collect-bank.test.ts`**

Подделки: плагин (объект `BankPlugin` с управляемыми ответами), хранилище
сессий в памяти, `LoginPrompt`, который ничего не открывает, и `fetchImpl`,
отвечающий на две ручки приложения:

```ts
import { expect, test, vi } from 'vitest'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials } from '../core/contract'
import type { FetchImpl } from '../http/allowlist-client'
import { collectBank, type CollectHost, type SessionStore } from './collect-bank'
import { accountFingerprint } from './fingerprint'

const LIVE: Credentials = { kind: 'header', name: 'Cookie', value: 'live' }
const FRESH: Credentials = { kind: 'header', name: 'Cookie', value: 'fresh' }

function account(id: string): CollectedAccount {
  return { id, name: `Счёт ${id}`, type: 'card', currency: 'RUB', balance: '10.00', creditLimit: null, cardMasks: [] }
}

function operation(external_id: string): CollectedOperation {
  return {
    occurred_at: '2026-09-01T10:00:00+03:00',
    amount: '-1.00',
    currency: 'RUB',
    description: 'кофе',
    external_id,
    kind: 'purchase',
    category_hint: null,
  }
}

function plugin(overrides: Partial<BankPlugin> = {}): BankPlugin {
  return {
    name: 'sber',
    login: vi.fn(async () => FRESH),
    isAlive: vi.fn(async (c: Credentials) => c.kind === 'header' && (c.value === 'live' || c.value === 'fresh')),
    fetchAccounts: vi.fn(async () => [account('a'), account('b')]),
    fetchOperations: vi.fn(async (_c: Credentials, id: string) => [operation(`${id}-1`)]),
    ...overrides,
  }
}

function sessions(initial: Credentials | null): SessionStore & { saved: Credentials | null } {
  const store = {
    saved: initial,
    async read() {
      return store.saved
    },
    async write(_bank: string, credentials: Credentials) {
      store.saved = credentials
    },
  }
  return store
}

/** Приложение: привязан только счёт «a»; импорты создаются с порядковым id. */
async function appFetch(linkedIds: string[], failImportFor: string | null = null): Promise<FetchImpl> {
  const linked: Record<string, string> = {}
  for (const id of linkedIds) linked[await accountFingerprint('sber', id)] = `app-${id}`
  let imports = 0
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/accounts/discovered') return new Response(JSON.stringify({ linked }))
    const target = url.searchParams.get('account_id')
    if (target === failImportFor) return new Response(JSON.stringify({ detail: 'Валюта не совпадает' }), { status: 422 })
    imports += 1
    return new Response(JSON.stringify({ import_id: `imp-${imports}`, status: 'pending' }), { status: 201 })
  }) as unknown as FetchImpl
}

function host(overrides: Partial<CollectHost>): CollectHost {
  return {
    plugin: plugin(),
    sessions: sessions(LIVE),
    prompt: { withBrowser: vi.fn(async () => { throw new Error('окно не должно открываться') }) },
    app: { baseUrl: 'http://app.local', workspaceId: 'ws-1', authorization: 'Session t' },
    days: 30,
    now: () => Date.parse('2026-09-29T00:00:00Z'),
    ...overrides,
  }
}

test('живая сессия — вход не нужен, собираются только привязанные счета', async () => {
  const summary = await collectBank(host({ fetchImpl: await appFetch(['a']) }))
  expect(summary.session).toBe('stored')
  expect(summary.accounts).toEqual([
    expect.objectContaining({ appAccountId: 'app-a', collected: 1, importId: 'imp-1', error: null }),
  ])
  expect(summary.unboundCount).toBe(1)
})

test('мёртвая сессия — вход, свежий секрет сохранён, итог говорит о свежем входе', async () => {
  const store = sessions({ kind: 'header', name: 'Cookie', value: 'dead' })
  const summary = await collectBank(host({ sessions: store, fetchImpl: await appFetch(['a']) }))
  expect(summary.session).toBe('login')
  expect(store.saved).toEqual(FRESH)
})

test('банк не признал сессию после входа — ошибка, секрет не сохранён', async () => {
  const store = sessions(null)
  const p = plugin({ isAlive: vi.fn(async () => false) })
  await expect(collectBank(host({ plugin: p, sessions: store, fetchImpl: await appFetch(['a']) }))).rejects.toThrow(
    /не признал/,
  )
  expect(store.saved).toBeNull()
})

test('недоступность банка при проверке сессии — ошибка без входа', async () => {
  const p = plugin({ isAlive: vi.fn(async () => { throw new Error('Банк недоступен (таймаут)') }) })
  await expect(collectBank(host({ plugin: p, fetchImpl: await appFetch(['a']) }))).rejects.toThrow(/недоступен/)
  expect(p.login).not.toHaveBeenCalled()
})

test('отказ импорта по одному счёту не мешает другому', async () => {
  const summary = await collectBank(host({ fetchImpl: await appFetch(['a', 'b'], 'app-a') }))
  expect(summary.accounts).toEqual([
    expect.objectContaining({ appAccountId: 'app-a', importId: null, error: expect.stringMatching(/422/) }),
    expect.objectContaining({ appAccountId: 'app-b', importId: 'imp-1', error: null }),
  ])
})

test('сессия приложения кончилась — сбор останавливается целиком, а не по счетам', async () => {
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as FetchImpl
  await expect(collectBank(host({ fetchImpl }))).rejects.toMatchObject({ status: 401 })
})

test('ни одного привязанного счёта — операции не запрашиваются', async () => {
  const p = plugin()
  const summary = await collectBank(host({ plugin: p, fetchImpl: await appFetch([]) }))
  expect(summary.accounts).toEqual([])
  expect(summary.unboundCount).toBe(2)
  expect(p.fetchOperations).not.toHaveBeenCalled()
})

test('период сбора — последние days дней от now', async () => {
  const p = plugin()
  await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a']) }))
  const until = Date.parse('2026-09-29T00:00:00Z')
  expect(p.fetchOperations).toHaveBeenCalledWith(LIVE, 'a', until - 30 * 86_400_000, until)
})
```

- [ ] **Step 2: красный прогон** — `pnpm test src/collect/collect-bank.test.ts`. Expected: FAIL (модуля нет).

- [ ] **Step 3: реализация**

```ts
// collector/src/collect/collect-bank.ts
import type { BankPlugin, CollectedAccount, Credentials, LoginPrompt } from '../core/contract'
import type { FetchImpl } from '../http/allowlist-client'
import { AppHttpError } from './app-api'
import type { AppConnection } from './app-connection'
import { syncDiscovered } from './discovered'
import { pushOperations } from './push'
import { countCollected, type CollectedCounters } from './report'

const DAY_MS = 86_400_000

/** Где живёт секрет сессии банка между сборами. */
export interface SessionStore {
  read(bank: string): Promise<Credentials | null>
  write(bank: string, credentials: Credentials): Promise<void>
}

/** Всё, что сбору нужно от места, где он работает: приложение, CLI, тест. */
export interface CollectHost {
  plugin: BankPlugin
  sessions: SessionStore
  prompt: LoginPrompt
  app: AppConnection
  /** За сколько дней забирать операции. */
  days: number
  now?: () => number
  fetchImpl?: FetchImpl
}

/** Откуда сессия: из хранилища или из только что пройденного входа. */
export type SessionSource = 'stored' | 'login'

export interface AccountResult {
  appAccountId: string
  collected: number
  /** null — операций за период нет, импорт не создавался (или отказ, см. error). */
  importId: string | null
  counters: CollectedCounters
  /** Отказ по этому счёту; остальные счета собираются дальше. */
  error: string | null
}

export interface CollectSummary {
  bank: string
  session: SessionSource
  accounts: AccountResult[]
  /** Счета, которые банк показал, а в приложении они ни к чему не привязаны. */
  unboundCount: number
}

export async function collectBank(host: CollectHost): Promise<CollectSummary> {
  const { credentials, source } = await connect(host)
  const bankAccounts = await host.plugin.fetchAccounts(credentials)
  // какие счета вести, решает человек на экране «Счета»; сбор только сообщает,
  // что показал банк, и собирает привязанное
  const linked = await syncDiscovered(host.app, host.plugin.name, bankAccounts, host.fetchImpl)

  const until = (host.now ?? Date.now)()
  const since = until - host.days * DAY_MS
  const accounts: AccountResult[] = []
  for (const account of bankAccounts) {
    const appAccountId = linked.get(account.id)
    // счёт банка, который человек не завёл: не ошибка, а обычное дело
    if (appAccountId === undefined) continue
    accounts.push(await collectAccount(host, credentials, account, appAccountId, since, until))
  }
  return { bank: host.plugin.name, session: source, accounts, unboundCount: bankAccounts.length - accounts.length }
}

/**
 * Живость сессии проверяем до всякой работы. Мёртвый секрет остаётся в
 * хранилище, и без этой проверки каждый сбор доставал бы его заново и падал
 * посреди работы.
 */
async function connect(host: CollectHost): Promise<{ credentials: Credentials; source: SessionSource }> {
  const saved = await host.sessions.read(host.plugin.name)
  if (saved !== null && (await host.plugin.isAlive(saved))) return { credentials: saved, source: 'stored' }

  const fresh = await host.plugin.login(host.prompt)
  if (!(await host.plugin.isAlive(fresh))) throw new Error('Вход выполнен, но банк не признал полученную сессию')
  await host.sessions.write(host.plugin.name, fresh)
  return { credentials: fresh, source: 'login' }
}

async function collectAccount(
  host: CollectHost,
  credentials: Credentials,
  account: CollectedAccount,
  appAccountId: string,
  since: number,
  until: number,
): Promise<AccountResult> {
  try {
    const operations = await host.plugin.fetchOperations(credentials, account.id, since, until)
    const pushed = await pushOperations(host.app, host.plugin.name, appAccountId, operations, account, host.fetchImpl)
    return {
      appAccountId,
      collected: operations.length,
      importId: pushed?.import_id ?? null,
      counters: countCollected(operations),
      error: null,
    }
  } catch (error) {
    // кончилась сессия приложения — дальше каждый счёт получит тот же отказ;
    // это не частичный успех, а повод показать вход
    if (error instanceof AppHttpError && error.status === 401) throw error
    return {
      appAccountId,
      collected: 0,
      importId: null,
      counters: countCollected([]),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
```

- [ ] **Step 4: зелёный прогон** — `pnpm test src/collect`.

- [ ] **Step 5: вход для приложения** — всё, что приложению нужно от коллектора,
одним модулем; фронт импортирует только его, и если в граф попадёт Node, это
увидит `tsc` фронта:

```ts
// collector/src/app.ts
export { collectBank } from './collect/collect-bank'
export type { AccountResult, CollectHost, CollectSummary, SessionSource, SessionStore } from './collect/collect-bank'
export type { AppConnection } from './collect/app-connection'
export { AppHttpError } from './collect/app-api'
export { parseCredentials, serializeCredentials } from './collect/credentials-codec'
export { accountsWord } from './collect/report'
export type { CollectedCounters } from './collect/report'
export { BANK_NAMES, pluginFor } from './plugins/registry'
export type { BrowserSession, Credentials, LoginPrompt } from './core/contract'
export type { HttpResponse, SendOptions, Transport } from './http/transport'
```

Проба фронтом (как в задаче 4, шаг 9) с `import { collectBank } from '../../collector/src/app'` — без ошибок.

- [ ] **Step 6: CLI на `collectBank`.** `runner/print-summary.ts` печатает итог
теми же строками, что и сейчас: по счёту — `счёт <id>: собрано N, импорт <id>` /
`операций за период нет` / `счёт <id>: <ошибка>`; затем три счётчика тем же
текстом, что в `report.ts`; затем `В банке ещё <accountsWord(n)> не ведётся…`,
если `unboundCount > 0`; и строку об источнике сессии — `сессия: из
хранилища` или `сессия: свежий вход` (пункт бэклога «Коллектор молчит о том,
что открывал окно входа»). `runner/main.ts` сводится к сборке `CollectHost` из
конфига (`osSecretStore()`, `browserPrompt(...)`, `appConnection(config)`,
`config.days`) и `printSummary(await collectBank(host))`. Функции `connect` и
`collect` из `main.ts` удалить — они теперь в `collect-bank.ts`.

- [ ] **Step 7: прогон** — `pnpm test && pnpm lint && pnpm build && pnpm reference`.

- [ ] **Step 8: справочник** — `collector.md`, «Что коллектор сообщает по итогам
сбора»: итог — объект `CollectSummary` (`collect-bank.ts:<строка>`), источник
сессии в нём; частичный успех; 401 приложения останавливает сбор.

- [ ] **Step 9: коммит**

```bash
git add collector docs/reference/collector.md
git commit -m "Сбор банка — функция collectBank с обвязками параметром; CLI печатает её итог"
```

- [ ] **Step 10: проверка дефектом** — два прогона, каждый с откатом:
  1. в `collectAccount` убрать повторный `throw` для 401 → FAIL «сессия приложения кончилась»;
  2. в `connect` писать секрет до проверки `isAlive(fresh)` → FAIL «банк не признал сессию после входа».

---

## Этап C. Оболочка `desktop/`

Код Rust ниже опирается на прототипы разведки (`spike/tauri`, `spike/tauri-mobile`
в worktree; в репозиторий не попадают) — там каждый вызов Tauri и reqwest
отработал на этой машине.

**Важно для всех задач этапа C:** `tauri::generate_context!` читает
`frontendDist` при компиляции. Без собранного фронта `cargo build`/`cargo test`
не собираются. Перед первой сборкой оболочки: `pnpm --dir frontend build`.

### Задача 9: каркас приложения Tauri

**Files:**
- Create: `desktop/package.json`, `desktop/.gitignore`
- Create: `desktop/src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`
- Create: `desktop/src-tauri/capabilities/default.json`
- Create: `desktop/src-tauri/src/main.rs`, `lib.rs`
- Create: `desktop/src-tauri/icons/*` (генерация)
- Create: `desktop/src-tauri/russian_trusted_root_ca.pem`
- Create: `desktop/README.md`

- [ ] **Step 1: `desktop/package.json`**

```json
{
  "name": "aiccountant-desktop",
  "private": true,
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "tauri": "tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.12.0"
  }
}
```

Run (в `desktop/`): `pnpm install`. Expected: `@tauri-apps/cli 2.12.x`.

- [ ] **Step 2: `desktop/.gitignore`**

```
node_modules/
src-tauri/target/
src-tauri/gen/
```

- [ ] **Step 3: `desktop/src-tauri/Cargo.toml`**

```toml
[package]
name = "aiccountant-desktop"
version = "0.1.0"
edition = "2021"

[lib]
name = "aiccountant_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
keyring = { version = "3", features = ["windows-native", "apple-native"] }

[dev-dependencies]
base64 = "0.22"
sha2 = "0.10"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "net", "io-util"] }
```

- [ ] **Step 4: `build.rs`** — манифест команд. Команда, которой нет в списке,
из окна не вызывается вовсе:

```rust
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bank_request",
            "secret_session_read",
            "secret_session_write",
            "secret_session_clear",
            "app_token_read",
            "app_token_write",
            "app_token_clear",
            "bank_window_open",
            "bank_window_goto",
            "bank_window_url",
            "bank_window_cookies",
            "bank_window_clear_cookie",
            "bank_window_close",
            "bank_forget",
        ]),
    ))
    .expect("сборка манифеста команд");
}
```

- [ ] **Step 5: `tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "AIccountant",
  "version": "0.1.0",
  "identifier": "ru.aiccountant.desktop",
  "build": {
    "devUrl": "http://localhost:5173",
    "frontendDist": "../../frontend/dist",
    "beforeDevCommand": "pnpm --dir ../frontend dev",
    "beforeBuildCommand": "pnpm --dir ../frontend build"
  },
  "app": {
    "windows": [{ "label": "main", "title": "AIccountant", "width": 1280, "height": 800 }],
    "security": { "csp": null }
  },
  "bundle": { "active": false, "icon": ["icons/icon.png", "icons/icon.ico"] }
}
```

`csp: null` — как в прототипах; адрес сервера задаётся человеком, и
перечислить его в CSP заранее нельзя. Записать это решение в `docs/reference/desktop.md`
(задача 22). Каталог, в котором Tauri выполняет `beforeDevCommand`, проверить
на шаге 9: если `pnpm --dir ../frontend` не находит фронт, путь поправить и
записать в `desktop/README.md`, откуда он считается.

- [ ] **Step 6: `capabilities/default.json`** — команды доступны только окну
`main`. Окна банков (`bank-*`) не перечислены и не получают ничего: их страница —
чужой код.

```json
{
  "identifier": "default",
  "description": "Окно приложения. Окна банков сюда не входят намеренно.",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "allow-bank-request",
    "allow-secret-session-read",
    "allow-secret-session-write",
    "allow-secret-session-clear",
    "allow-app-token-read",
    "allow-app-token-write",
    "allow-app-token-clear",
    "allow-bank-window-open",
    "allow-bank-window-goto",
    "allow-bank-window-url",
    "allow-bank-window-cookies",
    "allow-bank-window-clear-cookie",
    "allow-bank-window-close",
    "allow-bank-forget"
  ]
}
```

- [ ] **Step 7: точка входа** — на этом шаге без команд; они появятся в задачах 10–13.

```rust
// desktop/src-tauri/src/main.rs
// без консольного окна в сборке для человека; в отладке консоль нужна
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aiccountant_desktop_lib::run()
}
```

```rust
// desktop/src-tauri/src/lib.rs
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("приложение не запустилось");
}
```

Пока команд нет, `build.rs` перечисляет ещё не написанные — `tauri-build` на
это не ругается: он строит манифест разрешений, а не проверяет обработчики
(проверено на прототипе 2026-09-29).

- [ ] **Step 8: иконки и корень**

```bash
cd desktop
pnpm tauri icon ../frontend/public/favicon.svg --fit contain -o src-tauri/icons
cp ../collector/profile/russian_trusted_root_ca.pem src-tauri/  # если в worktree нет profile/ — взять из основного каталога, файл проверяется тестом в задаче 10
```

Без `--fit contain` команда отказывает: исходник не квадратный (проверено).
Предупреждение про цвет `display-p3` безвредно.

- [ ] **Step 9: запуск**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd desktop && pnpm tauri dev
```

Expected: открывается окно «AIccountant» с экраном входа фронта (пока — браузерный
режим, вход не пройдёт: адрес сервера появится в задаче 15). Закрыть окно.

- [ ] **Step 10: `desktop/README.md`** — требования (Rust через rustup, MSVC и
Windows SDK из Visual Studio Build Tools, WebView2 — есть в Windows 10/11),
запуск `pnpm tauri dev`, где лежат профили банков и секреты (задачи 12–13
допишут). Грабли из разведки, §3.6.

- [ ] **Step 11: коммит**

```bash
git add desktop
git commit -m "Каркас десктопного приложения на Tauri: окно с фронтом, команды только окну приложения"
```

---

### Задача 10: банки и список разрешённых адресов в Rust

Гарантия «коллектор физически не способен обратиться никуда, кроме
перечисленных адресов» переезжает туда, где стоит сама отправка (спека, §3.1).
Списки — дословно из `collector/src/plugins/*/client.ts`.

**Files:**
- Create: `desktop/src-tauri/src/banks.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`mod banks;`)

- [ ] **Step 1: тесты (в конце `banks.rs`)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allowed_endpoint_passes() {
        let tbank = bank("tbank").unwrap();
        assert!(check_request(tbank, "GET", &url("https://www.tbank.ru/api/common/v1/session_status?sessionid=x")).is_ok());
    }

    #[test]
    fn foreign_path_method_host_rejected() {
        let sber = bank("sber").unwrap();
        let ok = "https://web-node3.online.sberbank.ru/uoh-bh/v1/operations/list";
        assert!(check_request(sber, "POST", &url(ok)).is_ok());
        assert!(check_request(sber, "GET", &url(ok)).is_err(), "чужой метод");
        assert!(check_request(sber, "POST", &url("https://web-node3.online.sberbank.ru/uoh-bh/v1/operations/delete")).is_err(), "чужой путь");
        assert!(check_request(sber, "POST", &url("https://evil.example/uoh-bh/v1/operations/list")).is_err(), "чужой хост");
        assert!(check_request(sber, "POST", &url("http://web-node3.online.sberbank.ru/uoh-bh/v1/operations/list")).is_err(), "не https");
        assert!(check_request(sber, "POST", &url("https://web-node3.online.sberbank.ru:8443/uoh-bh/v1/operations/list")).is_err(), "чужой порт");
        assert!(check_request(sber, "POST", &url("https://u:p@web-node3.online.sberbank.ru/uoh-bh/v1/operations/list")).is_err(), "учётные данные в адресе");
    }

    #[test]
    fn one_bank_cannot_reach_another() {
        let alfa = bank("alfa").unwrap();
        assert!(check_request(alfa, "GET", &url("https://www.tbank.ru/api/common/v1/accounts_light_ib")).is_err());
    }

    #[test]
    fn rejection_does_not_leak_query() {
        let tbank = bank("tbank").unwrap();
        let err = check_request(tbank, "POST", &url("https://www.tbank.ru/api/common/v1/session_status?sessionid=SECRET")).unwrap_err();
        assert!(!err.contains("SECRET"));
    }

    #[test]
    fn unknown_bank_rejected() {
        assert!(bank("toString").is_err());
    }

    #[test]
    fn trust_per_bank() {
        assert_eq!(bank("sber").unwrap().trust, Trust::RootOnly);
        assert_eq!(bank("alfa").unwrap().trust, Trust::RootOnly);
        assert_eq!(bank("tbank").unwrap().trust, Trust::SystemAndRoot);
    }

    #[test]
    fn login_pages_stay_on_bank_domain() {
        let alfa = bank("alfa").unwrap();
        assert!(is_bank_page(alfa, &url("https://private.auth.alfabank.ru/passport/x")));
        assert!(is_bank_page(alfa, &url("https://alfabank.ru/")));
        assert!(!is_bank_page(alfa, &url("https://alfabank.ru.evil.example/")));
        assert!(!is_bank_page(alfa, &url("https://notalfabank.ru/")));
        assert!(!is_bank_page(alfa, &url("http://web.alfabank.ru/")));
    }

    #[test]
    fn root_is_the_mincifry_root() {
        // тот же отпечаток, что зашит в collector/src/runner/trust-anchor.ts
        let body: String = ROOT_PEM.lines().filter(|l| !l.starts_with("-----")).collect();
        let der = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
        let hex: String = Sha256::digest(&der).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "d26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31");
    }
}
```

- [ ] **Step 2: реализация (начало `banks.rs`)**

```rust
//! Банки, с которыми говорит оболочка: куда разрешено ходить и чему доверять.
//! Слова банков живут здесь и в плагинах коллектора — дальше они не уходят.

use tauri::Url;

/// Корень УЦ Минцифры. Доверие держится на его отпечатке, который сверяет тест.
pub const ROOT_PEM: &str = include_str!("../russian_trusted_root_ca.pem");
/// SPKI-отпечаток того же корня — им окно входа закрепляет УЦ.
pub const ROOT_SPKI_SHA256: &str = "ArgiDAcHKNt3HZrFnlRSHE7drSGng7smz98ZwdsPrjc=";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust {
    /// Только корень Минцифры: домен банка выпущен одним этим УЦ.
    RootOnly,
    /// Системный набор плюс корень Минцифры: банк отдаёт цепочку Минцифры
    /// (замер 2026-09-29), а отдаёт ли кому-то прежнюю — не проверено.
    SystemAndRoot,
}

pub struct Bank {
    pub code: &'static str,
    /// Хост API: запросы коллектора уходят только сюда.
    pub api_host: &'static str,
    /// Домен окна входа: вход проходит по поддоменам (Альфа уводит на
    /// private.auth.alfabank.ru), поэтому граница — домен, а не хост.
    pub domain: &'static str,
    /// Пары «метод, путь» — весь набор возможностей коллектора по банку.
    pub allowed: &'static [(&'static str, &'static str)],
    pub trust: Trust,
}

pub const BANKS: &[Bank] = &[
    Bank {
        code: "tbank",
        api_host: "www.tbank.ru",
        domain: "tbank.ru",
        allowed: &[
            ("GET", "/api/common/v1/accounts_light_ib"),
            ("GET", "/api/common/v1/session_status"),
            ("GET", "/mybank/api/operations/timeline/public/legacy/v1/operations"),
            ("GET", "/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank"),
            ("GET", "/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user"),
        ],
        trust: Trust::SystemAndRoot,
    },
    Bank {
        code: "sber",
        api_host: "web-node3.online.sberbank.ru",
        domain: "sberbank.ru",
        // Сбер отдаёт данные по POST: метод здесь безвредности не доказывает,
        // гарантия — сам список, и все три адреса читающие
        allowed: &[
            ("POST", "/uoh-bh/v1/operations/list"),
            ("POST", "/main-screen/rest/v2/m1/web/section/meta"),
            ("POST", "/ufs-carddetail/rest/card/v1/cardInfo"),
        ],
        trust: Trust::RootOnly,
    },
    Bank {
        code: "alfa",
        api_host: "web.alfabank.ru",
        domain: "alfabank.ru",
        allowed: &[
            ("POST", "/api/v1/operations-history/operations"),
            ("GET", "/api/v1/account/"),
            ("GET", "/api/v1/cards/masked-cards"),
        ],
        trust: Trust::RootOnly,
    },
];

pub fn bank(code: &str) -> Result<&'static Bank, String> {
    BANKS
        .iter()
        .find(|b| b.code == code)
        .ok_or_else(|| format!("Неизвестный банк: {code}"))
}

/// Запрос разрешён, только если совпали всё сразу: https, хост API банка без
/// порта и учётных данных, пара «метод, путь» из списка. Query не проверяется:
/// в нём параметры и у Т-Банка секрет сессии; в текст отказа он не попадает.
pub fn check_request(bank: &Bank, method: &str, url: &Url) -> Result<(), String> {
    let allowed = url.scheme() == "https"
        && url.host_str() == Some(bank.api_host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && bank.allowed.iter().any(|(m, p)| *m == method && *p == url.path());
    if allowed {
        Ok(())
    } else {
        Err(format!("Не разрешено: {} {} {}", bank.code, method, url.path()))
    }
}

/// Страница, куда окно входа банка может перейти по нашей команде.
pub fn is_bank_page(bank: &Bank, url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == bank.domain || host.ends_with(&format!(".{}", bank.domain)))
}
```

- [ ] **Step 3: прогон**

```bash
cd desktop/src-tauri && cargo test banks && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

Expected: 8 тестов PASS. (Писать тест до реализации в Rust нельзя без заглушек —
модуль не скомпилируется; поэтому красный прогон здесь — проверка дефектом на шаге 5.)

- [ ] **Step 4: коммит**

```bash
git add desktop/src-tauri
git commit -m "Список разрешённых адресов банков — в Rust, там, где стоит отправка"
```

- [ ] **Step 5: проверка дефектом** — два прогона с откатом:
  1. убрать `url.host_str() == Some(bank.api_host)` → FAIL `foreign_path_method_host_rejected`, `one_bank_cannot_reach_another`;
  2. в `is_bank_page` заменить `ends_with(&format!(".{}", ...))` на `ends_with(bank.domain)` → FAIL `login_pages_stay_on_bank_domain`.

---

### Задача 11: команда `bank_request`

**Files:**
- Create: `desktop/src-tauri/src/http.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (`mod http;`, регистрация команды)

- [ ] **Step 1: реализация**

```rust
//! Запрос к банку от имени ядра коллектора. Окно приложения само в банк не
//! ходит: помешал бы CORS, а главное — только здесь можно поставить список
//! адресов и доверие к УЦ так, чтобы скрипт окна их не обошёл.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use tauri::Url;

use crate::banks::{self, Bank, Trust};

const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize)]
pub struct BankResponse {
    pub status: u16,
    /// Тело только у успешного ответа: тело отказа ядру не нужно, а в нём
    /// бывают данные, которые незачем тащить в окно.
    pub body: String,
}

/// Клиент под доверие банка. Редирект не проходится: 3xx возвращается ответом,
/// как и в прежних транспортах коллектора, — иначе редирект обошёл бы список.
pub fn client_for(bank: &Bank) -> Result<reqwest::Client, String> {
    let root = reqwest::Certificate::from_pem(banks::ROOT_PEM.as_bytes())
        .map_err(|e| format!("Корень УЦ не читается: {e}"))?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .add_root_certificate(root);
    if bank.trust == Trust::RootOnly {
        builder = builder.tls_built_in_root_certs(false);
    }
    builder.build().map_err(|e| format!("HTTP-клиент не собрался: {e}"))
}

#[tauri::command]
pub async fn bank_request(
    bank: String,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<BankResponse, String> {
    let bank = banks::bank(&bank)?;
    let url = Url::parse(&url).map_err(|_| "Неверный адрес запроса".to_string())?;
    banks::check_request(bank, &method, &url)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Неверный метод".to_string())?;

    let mut request = client_for(bank)?.request(method, url.as_str());
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|e| describe(&e))?;
    let status = response.status();
    let body = if status.is_success() {
        response.text().await.map_err(|e| describe(&e))?
    } else {
        String::new()
    };
    Ok(BankResponse { status: status.as_u16(), body })
}

/// Текст ошибки reqwest несёт адрес запроса, а в адресе Т-Банка — секрет
/// сессии. Наружу уходит только вид сбоя.
fn describe(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "таймаут"
    } else if error.is_connect() {
        "нет соединения"
    } else if error.is_body() || error.is_decode() {
        "обрыв ответа"
    } else {
        "сбой запроса"
    };
    format!("Банк недоступен ({kind})")
}
```

- [ ] **Step 2: тесты** — в конце `http.rs`. Проверяется то, что не требует банка:
отказ до сети и отказ от редиректа (локальный сервер, клиентом банка напрямую,
минуя список: список проверен в задаче 10).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn not_allowed_request_never_leaves() {
        let err = bank_request(
            "tbank".into(),
            "GET".into(),
            "https://evil.example/api/common/v1/session_status".into(),
            HashMap::new(),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("Не разрешено"));
    }

    #[tokio::test]
    async fn redirect_is_returned_not_followed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let reply = "HTTP/1.1 302 Found\r\nLocation: http://evil.example/\r\nContent-Length: 0\r\n\r\n";
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        let client = client_for(banks::bank("sber").unwrap()).unwrap();
        let resp = client.get(format!("http://{addr}/")).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 302);
    }
}
```

- [ ] **Step 3: регистрация** — в `lib.rs`:

```rust
mod banks;
mod http;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![http::bank_request])
        .run(tauri::generate_context!())
        .expect("приложение не запустилось");
}
```

- [ ] **Step 4: прогон** — `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.

- [ ] **Step 5: коммит**

```bash
git add desktop/src-tauri/src
git commit -m "Команда bank_request: запрос к банку только по списку и с доверием банка"
```

- [ ] **Step 6: проверка дефектом** — убрать `.redirect(reqwest::redirect::Policy::none())`
→ FAIL `redirect_is_returned_not_followed` (reqwest пойдёт за `Location`). Откатить.

---

### Задача 12: секреты устройства

Виды записей разделены, у каждого вида свои команды; общей команды «прочитать
секрет по имени» нет (спека, §5.1 — место под ПИН-код, §5.2).

**Files:**
- Create: `desktop/src-tauri/src/secrets.rs`
- Modify: `desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: реализация с тестами**

```rust
//! Секреты устройства в хранилище ОС: Credential Manager, Keychain.
//!
//! Записи разделены по видам, и у каждого вида свои команды. Общей команды
//! «прочитать секрет по имени» нет намеренно: следующий вид — ПИН-код банка —
//! окну приложения читать нельзя вовсе, и он не должен получить готовую дверь.
//! Все чтения и записи идут через этот модуль — сюда же встанет шифрование
//! мастер-кодом, если его заведут.

use crate::banks;

const SERVICE: &str = "aiccountant";
const APP_TOKEN_KEY: &str = "app-token";

pub trait Backend {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

pub struct OsKeyring;

impl Backend for OsKeyring {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(unavailable(e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        entry(key)?.set_password(value).map_err(unavailable)
    }

    // стирать нечего — не ошибка: «забыть доступ» работает и до первого входа
    fn delete(&self, key: &str) -> Result<(), String> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(unavailable(e)),
        }
    }
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(unavailable)
}

// сбой хранилища — не «секрета нет»: иначе «доступ забыт» звучало бы, когда он
// не забыт, а чтение отправляло бы на вход вместо честного сообщения
fn unavailable(error: keyring::Error) -> String {
    format!("Хранилище секретов недоступно ({error})")
}

fn session_key(bank: &str) -> Result<String, String> {
    Ok(format!("session:{}", banks::bank(bank)?.code))
}

pub fn read_session(backend: &impl Backend, bank: &str) -> Result<Option<String>, String> {
    backend.get(&session_key(bank)?)
}

pub fn write_session(backend: &impl Backend, bank: &str, value: &str) -> Result<(), String> {
    backend.set(&session_key(bank)?, value)
}

pub fn clear_session(backend: &impl Backend, bank: &str) -> Result<(), String> {
    backend.delete(&session_key(bank)?)
}

#[tauri::command]
pub fn secret_session_read(bank: String) -> Result<Option<String>, String> {
    read_session(&OsKeyring, &bank)
}

#[tauri::command]
pub fn secret_session_write(bank: String, value: String) -> Result<(), String> {
    write_session(&OsKeyring, &bank, &value)
}

#[tauri::command]
pub fn secret_session_clear(bank: String) -> Result<(), String> {
    clear_session(&OsKeyring, &bank)
}

#[tauri::command]
pub fn app_token_read() -> Result<Option<String>, String> {
    OsKeyring.get(APP_TOKEN_KEY)
}

#[tauri::command]
pub fn app_token_write(token: String) -> Result<(), String> {
    OsKeyring.set(APP_TOKEN_KEY, &token)
}

#[tauri::command]
pub fn app_token_clear() -> Result<(), String> {
    OsKeyring.delete(APP_TOKEN_KEY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, String>>);

    impl Backend for Memory {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(key);
            Ok(())
        }
    }

    #[test]
    fn sessions_of_banks_do_not_mix() {
        let m = Memory::default();
        write_session(&m, "sber", "s").unwrap();
        write_session(&m, "alfa", "a").unwrap();
        assert_eq!(read_session(&m, "sber").unwrap().as_deref(), Some("s"));
        assert_eq!(read_session(&m, "alfa").unwrap().as_deref(), Some("a"));
    }

    #[test]
    fn app_token_is_not_a_bank_session() {
        let m = Memory::default();
        m.set(APP_TOKEN_KEY, "token").unwrap();
        for bank in ["tbank", "sber", "alfa"] {
            assert_eq!(read_session(&m, bank).unwrap(), None);
        }
    }

    #[test]
    fn unknown_bank_is_not_a_key() {
        let m = Memory::default();
        assert!(read_session(&m, "app-token").is_err());
        assert!(write_session(&m, "../app-token", "x").is_err());
    }

    #[test]
    fn clear_is_idempotent() {
        let m = Memory::default();
        clear_session(&m, "tbank").unwrap();
        write_session(&m, "tbank", "t").unwrap();
        clear_session(&m, "tbank").unwrap();
        assert_eq!(read_session(&m, "tbank").unwrap(), None);
    }
}
```

- [ ] **Step 2: регистрация** — `mod secrets;` и шесть команд в `generate_handler!`.

- [ ] **Step 3: проверка на живом хранилище** — один раз руками: `cargo test`
хранилище ОС не трогает. Запустить `pnpm tauri dev`, в консоли разработчика окна
(`Ctrl+Shift+I`) выполнить:

```js
const { invoke } = window.__TAURI_INTERNALS__
await invoke('app_token_write', { token: 'проба' }); await invoke('app_token_read')   // 'проба'
await invoke('app_token_clear'); await invoke('app_token_read')                          // null
```

Если `window.__TAURI_INTERNALS__.invoke` недоступен в этом виде — проверку
перенести в задачу 15, где появляется `invoke` фронта.

- [ ] **Step 4: прогон, коммит**

```bash
git add desktop/src-tauri/src
git commit -m "Секреты устройства по видам: сессия банка и токен приложения, без общего чтения"
```

- [ ] **Step 5: проверка дефектом** — в `session_key` вернуть
`format!("session:{bank}")` без проверки банка → FAIL `unknown_bank_is_not_a_key`. Откатить.

---

### Задача 13: окно входа в банк и «забыть доступ»

**Files:**
- Create: `desktop/src-tauri/src/windows.rs`
- Modify: `desktop/src-tauri/src/lib.rs`

Все команды здесь `async`: создание окна и чтение кук на Windows зависают в
синхронной команде (`tauri-2.12.0/src/webview/webview_window.rs:58,2732`).

- [ ] **Step 1: реализация**

```rust
//! Окно входа в банк. У каждого банка свой профиль WebView2 в каталоге данных
//! приложения: там оседают привязка устройства и быстрый вход, и там же живёт
//! флаг закрепления корня Минцифры — окно приложения его не получает, потому
//! что у окружения WebView2 свой каталог.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::banks::{self, Bank};
use crate::secrets;

/// Флаги WebView2, которые Tauri ставит сам: additional_browser_args их
/// заменяет, а не дополняет, поэтому они повторены рядом с закреплением.
const DEFAULT_ARGS: &str = "--disable-features=msWebOoUI,msPdfOOUI,msSmartScreenProtection";

#[derive(Serialize)]
pub struct CookieOut {
    name: String,
    value: String,
}

fn label(bank: &Bank) -> String {
    format!("bank-{}", bank.code)
}

/// Закрепление ключа корня: «игнорировать ошибки сертификата для цепочек с
/// этим ключом», включая истёкший срок, — та же оговорка, что у прежнего окна
/// входа на Playwright.
fn browser_args() -> String {
    format!(
        "{DEFAULT_ARGS} --ignore-certificate-errors-spki-list={}",
        banks::ROOT_SPKI_SHA256
    )
}

fn profile_dir(app: &AppHandle, bank: &Bank) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("banks").join(bank.code))
}

fn window(app: &AppHandle, bank: &Bank) -> Result<WebviewWindow, String> {
    app.get_webview_window(&label(bank))
        .ok_or_else(|| "Окно банка закрыто".to_string())
}

/// Открыть окно банка на пустой странице. Пустая, а не страница банка: вход
/// Т-Банка сначала стирает протухшую куку и только потом идёт на страницу входа.
#[tauri::command]
pub async fn bank_window_open(app: AppHandle, bank: String, visible: bool) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    if let Some(old) = app.get_webview_window(&label(bank)) {
        old.destroy().map_err(|e| e.to_string())?;
    }
    WebviewWindowBuilder::new(&app, label(bank), WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Вход в банк")
        .inner_size(1024.0, 760.0)
        .visible(visible)
        .data_directory(profile_dir(&app, bank)?)
        .additional_browser_args(&browser_args())
        .build()
        .map_err(|e| format!("Окно банка не открылось: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn bank_window_goto(app: AppHandle, bank: String, url: String) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    let url = Url::parse(&url).map_err(|_| "Неверный адрес".to_string())?;
    if !banks::is_bank_page(bank, &url) {
        return Err(format!("Окно {} не уходит за пределы банка", bank.code));
    }
    window(&app, bank)?.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bank_window_url(app: AppHandle, bank: String) -> Result<String, String> {
    let bank = banks::bank(&bank)?;
    window(&app, bank)?
        .url()
        .map(|u| u.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bank_window_cookies(app: AppHandle, bank: String, url: String) -> Result<Vec<CookieOut>, String> {
    let bank = banks::bank(&bank)?;
    let url = Url::parse(&url).map_err(|_| "Неверный адрес".to_string())?;
    if !banks::is_bank_page(bank, &url) {
        return Err(format!("Куки {} читаются только со страниц банка", bank.code));
    }
    let cookies = window(&app, bank)?.cookies_for_url(url).map_err(|e| e.to_string())?;
    Ok(cookies
        .iter()
        .map(|c| CookieOut { name: c.name().to_string(), value: c.value().to_string() })
        .collect())
}

#[tauri::command]
pub async fn bank_window_clear_cookie(app: AppHandle, bank: String, name: String) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    let win = window(&app, bank)?;
    for cookie in win.cookies().map_err(|e| e.to_string())? {
        if cookie.name() == name {
            win.delete_cookie(cookie).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn bank_window_close(app: AppHandle, bank: String) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    if let Some(win) = app.get_webview_window(&label(bank)) {
        win.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Забыть доступ: профиль окна и секрет сессии. Профиль WebView2 держит файлы
/// ещё мгновение после закрытия окна, поэтому удаление повторяется.
#[tauri::command]
pub async fn bank_forget(app: AppHandle, bank: String) -> Result<(), String> {
    let bank = banks::bank(&bank)?;
    if let Some(win) = app.get_webview_window(&label(bank)) {
        win.destroy().map_err(|e| e.to_string())?;
    }
    let dir = profile_dir(&app, bank)?;
    let mut attempt = 0;
    loop {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) if attempt < 10 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(300));
            }
            Err(e) => return Err(format!("Профиль банка занят, повторите позже ({e})")),
        }
    }
    secrets::clear_session(&secrets::OsKeyring, bank.code)
}
```

`std::thread::sleep` в async-команде блокирует поток пула; для десяти пауз по
300 мс при редком действии это приемлемо, но если clippy или ревью возразят —
заменить на `tauri::async_runtime` с `tokio::time::sleep` (тогда `tokio` нужен
и в `[dependencies]`).

- [ ] **Step 2: тесты** — чистые функции модуля:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_label_is_per_bank() {
        assert_eq!(label(banks::bank("sber").unwrap()), "bank-sber");
    }

    #[test]
    fn pin_keeps_tauri_defaults() {
        let args = browser_args();
        assert!(args.contains("--disable-features=msWebOoUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(args.ends_with(&format!("--ignore-certificate-errors-spki-list={}", banks::ROOT_SPKI_SHA256)));
    }
}
```

Поведение самих окон проверяется в задаче 20 руками — оно доступно только с
живым WebView2.

- [ ] **Step 3: регистрация** — `mod windows;`, семь команд в `generate_handler!`.

- [ ] **Step 4: прогон, коммит**

```bash
git add desktop/src-tauri/src
git commit -m "Окно входа в банк со своим профилем и закреплённым корнем; «забыть доступ»"
```

- [ ] **Step 5: проверка дефектом** — в `bank_window_goto` убрать проверку
`is_bank_page`; тест её не ловит (она за живым окном), поэтому эта мутация
проверяется в задаче 20 руками: из консоли окна `invoke('bank_window_goto',
{ bank: 'sber', url: 'https://example.com/' })` обязан вернуть отказ. Здесь —
убедиться, что `login_pages_stay_on_bank_domain` из задачи 10 покрывает саму функцию.

---

## Этап D. Фронт в окне приложения

Вид экранов — минимальный, визуал не обсуждается (владелец, 2026-09-29).

### Задача 14: режим приложения — адрес сервера, токен, один путь запроса

**Files:**
- Modify: `frontend/package.json` (`@tauri-apps/api`, `aiccountant-collector`)
- Modify: `frontend/Dockerfile`
- Create: `frontend/src/desktop/runtime.ts`, `frontend/src/desktop/connection.ts`
- Modify: `frontend/src/api/client.ts`, `frontend/src/api/imports.ts`
- Create: `frontend/src/api/client.test.ts`

- [ ] **Step 1: зависимости**

```bash
cd frontend
pnpm add @tauri-apps/api@^2
pnpm add "aiccountant-collector@link:../collector"
```

- [ ] **Step 2: `frontend/Dockerfile`** — контекст сборки — корень репозитория,
но в образ сейчас копируется только `frontend/`; связанный пакет коллектора
должен лежать рядом, как в репозитории:

```dockerfile
FROM node:22-slim AS build
WORKDIR /app/frontend
RUN corepack enable
# фронт импортирует ядро коллектора исходниками (link:../collector) — кладём его
# рядом, как в репозитории. Зависимостей из npm ядру в окне не нужно
COPY collector/package.json /app/collector/package.json
COPY collector/src /app/collector/src
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ .
RUN pnpm build

FROM caddy:2
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/frontend/dist /srv
```

Проверка: `docker compose build caddy` из корня worktree — образ фронта
собирает сервис `caddy` (`docker-compose.yml`, `dockerfile: frontend/Dockerfile`).

- [ ] **Step 3: `runtime.ts`**

```ts
import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/** Фронт открыт в окне Tauri, а не во вкладке браузера. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Команда оболочки. Rust отдаёт ошибку строкой — превращаем её в Error. */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}
```

- [ ] **Step 4: `connection.ts`**

```ts
import { invoke } from './runtime'

const SERVER_KEY = 'aiccountant.server'
// по умолчанию — адрес из сборки; у каждого стенда свой порт, и человек меняет
// его на экране входа
const DEFAULT_SERVER: string = import.meta.env.VITE_DEFAULT_SERVER ?? 'http://localhost:8000'

// токен читается из хранилища ОС один раз при старте: запросы собираются
// синхронно, и ходить за ним в оболочку на каждый запрос незачем
let token: string | null = null

/** Адрес сервера приложения. Не секрет — живёт в localStorage окна. */
export function serverUrl(): string {
  return localStorage.getItem(SERVER_KEY) ?? DEFAULT_SERVER
}

export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_KEY, url.trim().replace(/\/+$/, ''))
}

export function sessionToken(): string | null {
  return token
}

export async function loadSession(): Promise<void> {
  token = await invoke<string | null>('app_token_read')
}

export async function saveSession(value: string): Promise<void> {
  await invoke('app_token_write', { token: value })
  token = value
}

export async function clearSession(): Promise<void> {
  await invoke('app_token_clear')
  token = null
}
```

- [ ] **Step 5: тесты `client.test.ts`**

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const desktop = { on: false }
vi.mock('../desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('../desktop/connection', () => ({
  serverUrl: () => 'http://localhost:18000',
  sessionToken: () => 'tok',
}))

import { apiFetch } from './client'

const fetchMock = vi.fn(async () => new Response('{}'))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockClear()
  desktop.on = false
})

test('в браузере — относительный адрес и cookie своего origin, без заголовка сессии', async () => {
  await apiFetch('/api/me')
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/me')
  expect(init.credentials).toBe('same-origin')
  expect(new Headers(init.headers).has('Authorization')).toBe(false)
})

test('в приложении — полный адрес сервера и сессия заголовком, cookie не шлются', async () => {
  desktop.on = true
  await apiFetch('/api/me', { headers: { 'Content-Type': 'application/json' } })
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('http://localhost:18000/api/me')
  expect(init.credentials).toBe('omit')
  const headers = new Headers(init.headers)
  expect(headers.get('Authorization')).toBe('Session tok')
  expect(headers.get('Content-Type')).toBe('application/json')
})
```

- [ ] **Step 6: красный прогон** — `pnpm test src/api/client.test.ts`. Expected: FAIL (`apiFetch` нет).

- [ ] **Step 7: `client.ts`**

```ts
import { serverUrl, sessionToken } from '../desktop/connection'
import { isDesktop } from '../desktop/runtime'

/**
 * Один путь запроса для браузера и приложения. В браузере — относительный адрес
 * и cookie своего origin; в приложении — полный адрес сервера и сессия
 * заголовком Session: cookie окна Tauri серверу не принадлежат.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isDesktop()) return fetch(path, { credentials: 'same-origin', ...init })
  const headers = new Headers(init.headers)
  const token = sessionToken()
  if (token !== null) headers.set('Authorization', `Session ${token}`)
  return fetch(`${serverUrl()}${path}`, { ...init, headers, credentials: 'omit' })
}
```

В `api()` заменить `fetch(path, { headers: …, credentials: 'same-origin', ...init })`
на `apiFetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })`.
В `imports.ts`, `startImport`: `fetch(\`/api/imports?${qs}\`, { method: 'POST',
credentials: 'same-origin', body: form })` → `apiFetch(\`/api/imports?${qs}\`, {
method: 'POST', body: form })`.

- [ ] **Step 8: прогон** — `pnpm test && pnpm lint && pnpm build` в `frontend/`. Expected: всё зелёное, прежние 84+ тестов не сломаны.

- [ ] **Step 9: коммит**

```bash
git add frontend
git commit -m "Фронт в окне приложения ходит на сервер по адресу и с сессией заголовком"
```

- [ ] **Step 10: проверка дефектом** — в `apiFetch` убрать `credentials: 'omit'`
→ FAIL второй тест. Откатить.

---

### Задача 15: вход в приложение из окна Tauri

**Files:**
- Modify: `frontend/src/api/auth.ts`
- Modify: `frontend/src/pages/LoginPage.tsx`, `LoginPage.test.tsx`
- Modify: `frontend/src/main.tsx` (загрузка сессии до первого рендера)

- [ ] **Step 1: тесты `LoginPage.test.tsx`** — добавить:

```ts
const desktop = { on: false }
vi.mock('../desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('../api/auth', () => ({ login: vi.fn(async () => ({ id: 'u', email: 'a@b.c', session_token: null })) }))

test('в браузере поля адреса сервера нет', () => {
  renderPage()
  expect(screen.queryByLabelText('Адрес сервера')).toBeNull()
})

test('в приложении адрес сервера запоминается до входа', async () => {
  desktop.on = true
  renderPage()
  const field = screen.getByLabelText('Адрес сервера')
  await userEvent.clear(field)
  await userEvent.type(field, 'http://localhost:18010/')
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  expect(localStorage.getItem('aiccountant.server')).toBe('http://localhost:18010')
  desktop.on = false
})
```

Импорты `vi`, `userEvent` — дополнить существующие в файле.

- [ ] **Step 2: красный прогон** — Expected: FAIL (поля нет).

- [ ] **Step 3: `auth.ts`**

```ts
import { clearSession, saveSession } from '../desktop/connection'
import { isDesktop } from '../desktop/runtime'

export interface UserOut {
  id: string
  email: string
  // приходит только приложению (client: 'app'); браузеру хватает cookie
  session_token: string | null
}

async function enter(path: string, email: string, password: string): Promise<UserOut> {
  const client = isDesktop() ? 'app' : 'browser'
  const user = await api<UserOut>(path, { method: 'POST', body: JSON.stringify({ email, password, client }) })
  if (client === 'app' && user.session_token) await saveSession(user.session_token)
  return user
}

export const login = (email: string, password: string) => enter('/api/auth/login', email, password)
export const register = (email: string, password: string) => enter('/api/auth/register', email, password)

export async function logout(): Promise<void> {
  await api<void>('/api/auth/logout', { method: 'POST' })
  if (isDesktop()) await clearSession()
}
```

- [ ] **Step 4: `LoginPage.tsx`** — в приложении над полем Email:

```tsx
{isDesktop() && (
  <TextInput label="Адрес сервера" mb="md" {...form.getInputProps('server')} />
)}
```

`initialValues` дополнить `server: isDesktop() ? serverUrl() : ''`; в
`mutationFn` перед `login(...)`: `if (isDesktop()) setServerUrl(values.server)`.
Тип значений формы — `{ server: string; email: string; password: string }`.

- [ ] **Step 5: `main.tsx`** — сессия читается до первого рендера, иначе первый
запрос `/api/me` уйдёт без заголовка и приведёт на экран входа:

```tsx
async function start(): Promise<void> {
  if (isDesktop()) await loadSession()
  createRoot(document.getElementById('root')!).render(/* прежнее дерево */)
}

void start()
```

- [ ] **Step 6: прогон** — `pnpm test && pnpm lint && pnpm build`.

- [ ] **Step 7: коммит**

```bash
git add frontend/src
git commit -m "Вход из приложения: адрес сервера на экране входа, сессия — в хранилище ОС"
```

- [ ] **Step 8: проверка дефектом** — в `enter` отправлять `client: 'browser'`
всегда; тест экрана входа это не ловит (он подменяет `login`) — поэтому
добавить в `client.test.ts`-соседа `auth.test.ts` тест: в режиме приложения
`login` шлёт `client: 'app'` и сохраняет `session_token` через `saveSession`
(подменить `../desktop/connection` и `fetch`). Мутация → FAIL этот тест. Откатить.

---

### Задача 16: обвязки коллектора — транспорт и окно входа

**Files:**
- Create: `frontend/src/desktop/bank-transport.ts`, `bank-transport.test.ts`
- Create: `frontend/src/desktop/bank-window.ts`, `bank-window.test.ts`

- [ ] **Step 1: тесты**

```ts
// bank-transport.test.ts
import { expect, test, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('./runtime', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { bankTransport } from './bank-transport'

test('запрос уходит в оболочку целиком, ответ собирается обратно', async () => {
  invoke.mockResolvedValueOnce({ status: 200, body: '{"a":1}' })
  const res = await bankTransport('sber').send(new URL('https://web-node3.online.sberbank.ru/x'), {
    method: 'POST',
    headers: { Cookie: 'c' },
    body: '{}',
    signal: new AbortController().signal,
  })
  expect(invoke).toHaveBeenCalledWith('bank_request', {
    bank: 'sber',
    method: 'POST',
    url: 'https://web-node3.online.sberbank.ru/x',
    headers: { Cookie: 'c' },
    body: '{}',
  })
  expect(res.ok).toBe(true)
  expect(await res.text()).toBe('{"a":1}')
})

test('не-2xx — ok ложно, статус сохранён', async () => {
  invoke.mockResolvedValueOnce({ status: 403, body: '' })
  const res = await bankTransport('sber').send(new URL('https://x/'), {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
  })
  expect(res.ok).toBe(false)
  expect(res.status).toBe(403)
})
```

```ts
// bank-window.test.ts
import { expect, test, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('./runtime', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { bankLoginPrompt } from './bank-window'

function fakeTiming() {
  let clock = 0
  return { now: () => clock, wait: async (ms: number) => { clock += ms } }
}

test('окно открывается видимым, закрывается и после ошибки', async () => {
  invoke.mockResolvedValue(undefined)
  const prompt = bankLoginPrompt('alfa', fakeTiming())
  await expect(prompt.withBrowser(async () => { throw new Error('сбой') })).rejects.toThrow('сбой')
  expect(invoke).toHaveBeenCalledWith('bank_window_open', { bank: 'alfa', visible: true })
  expect(invoke).toHaveBeenLastCalledWith('bank_window_close', { bank: 'alfa' })
})

test('ожидание адреса опрашивает окно до совпадения', async () => {
  const urls = ['about:blank', 'https://web.alfabank.ru/login', 'https://web.alfabank.ru/dashboard']
  invoke.mockImplementation(async (command: string) => (command === 'bank_window_url' ? urls.shift() : undefined))
  await bankLoginPrompt('alfa', fakeTiming()).withBrowser(async (session) => {
    await session.waitForUrl((url) => url.pathname.startsWith('/dashboard'), 10_000)
  })
  expect(urls).toEqual([])
})

test('время вышло — вход не завершён', async () => {
  invoke.mockImplementation(async (command: string) => (command === 'bank_window_url' ? 'about:blank' : undefined))
  await expect(
    bankLoginPrompt('alfa', fakeTiming()).withBrowser((session) => session.waitForUrl(() => false, 1_000)),
  ).rejects.toThrow(/не завершён/)
})
```

`beforeEach(() => invoke.mockReset())` в обоих файлах.

- [ ] **Step 2: красный прогон** — Expected: FAIL (модулей нет).

- [ ] **Step 3: `bank-transport.ts`**

```ts
import type { Transport } from 'aiccountant-collector/src/app'
import { invoke } from './runtime'

interface BankResponse {
  status: number
  body: string
}

/**
 * Транспорт ядра коллектора поверх команды оболочки bank_request. Список
 * адресов и доверие к УЦ проверяет Rust (desktop/src-tauri/src/banks.rs).
 * Сигнал отмены не пробрасывается: у запроса свой таймаут в оболочке (http.rs).
 */
export function bankTransport(bank: string): Transport {
  return {
    async send(url, { method, headers, body }) {
      const res = await invoke<BankResponse>('bank_request', {
        bank,
        method,
        url: url.toString(),
        headers,
        body: body ?? null,
      })
      return { status: res.status, ok: res.status >= 200 && res.status < 300, text: async () => res.body }
    },
  }
}
```

- [ ] **Step 4: `bank-window.ts`**

```ts
import type { BrowserSession, LoginPrompt } from 'aiccountant-collector/src/app'
import { invoke } from './runtime'

const URL_POLL_MS = 500

/** Часы ожидания. Подменяются в тестах. */
export interface WindowTiming {
  now(): number
  wait(ms: number): Promise<void>
}

const REAL_TIMING: WindowTiming = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Окно входа в банк поверх команд оболочки: своё на банк, со своим профилем. */
export function bankLoginPrompt(bank: string, timing: WindowTiming = REAL_TIMING): LoginPrompt {
  return {
    async withBrowser(use, options = {}) {
      await invoke('bank_window_open', { bank, visible: !(options.headless ?? false) })
      try {
        return await use(bankSession(bank, timing))
      } finally {
        await invoke('bank_window_close', { bank })
      }
    },
  }
}

function bankSession(bank: string, timing: WindowTiming): BrowserSession {
  return {
    goto: (url) => invoke<void>('bank_window_goto', { bank, url }),
    clearCookie: (name) => invoke<void>('bank_window_clear_cookie', { bank, name }),
    cookies: (url) => invoke<Array<{ name: string; value: string }>>('bank_window_cookies', { bank, url }),
    // Переход внутри одностраничного приложения банка событием навигации не
    // сообщается, поэтому адрес опрашивается. Окно, закрытое человеком, команда
    // отвергает — ожидание прерывается этой ошибкой
    async waitForUrl(match, timeoutMs) {
      const deadline = timing.now() + timeoutMs
      for (;;) {
        const current = await invoke<string>('bank_window_url', { bank })
        if (match(new URL(current))) return
        if (timing.now() >= deadline) throw new Error('Вход в банк не завершён: время ожидания вышло')
        await timing.wait(URL_POLL_MS)
      }
    },
  }
}
```

- [ ] **Step 5: прогон, коммит**

```bash
git add frontend/src/desktop
git commit -m "Транспорт и окно входа коллектора поверх команд оболочки"
```

- [ ] **Step 6: проверка дефектом** — убрать `finally` с закрытием окна → FAIL
«окно … закрывается и после ошибки». Откатить.

---

### Задача 17: сбор банка из окна приложения

**Files:**
- Create: `frontend/src/desktop/collector-host.ts`, `collector-host.test.ts`

- [ ] **Step 1: тесты**

```ts
import { beforeEach, expect, test, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('./runtime', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { osSessions, runExclusive } from './collector-host'

beforeEach(() => invoke.mockReset())

test('секрета нет — null', async () => {
  invoke.mockResolvedValueOnce(null)
  expect(await osSessions.read('sber')).toBeNull()
  expect(invoke).toHaveBeenCalledWith('secret_session_read', { bank: 'sber' })
})

test('непригодная запись — «секрета нет», а не сбой', async () => {
  invoke.mockResolvedValueOnce('не json')
  expect(await osSessions.read('sber')).toBeNull()
})

test('второй сбор того же банка, пока идёт первый, отвергается: профиль банка не открывают дважды', async () => {
  let release: () => void = () => {}
  invoke.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
  const first = runExclusive('sber', () => invoke('bank_window_open'))
  await expect(runExclusive('sber', async () => undefined)).rejects.toThrow(/уже идёт/)
  await expect(runExclusive('alfa', async () => 'другой банк')).resolves.toBe('другой банк')
  release()
  await first
  await expect(runExclusive('sber', async () => 'снова можно')).resolves.toBe('снова можно')
})

test('секрет пишется сериализованным и читается обратно', async () => {
  const credentials = { kind: 'header', name: 'Cookie', value: 'c' } as const
  await osSessions.write('sber', credentials)
  const [, args] = invoke.mock.calls[0] as [string, { value: string }]
  invoke.mockResolvedValueOnce(args.value)
  expect(await osSessions.read('sber')).toEqual(credentials)
})
```

- [ ] **Step 2: реализация**

```ts
import {
  collectBank,
  parseCredentials,
  pluginFor,
  serializeCredentials,
  type CollectSummary,
  type SessionStore,
} from 'aiccountant-collector/src/app'
import { bankTransport } from './bank-transport'
import { bankLoginPrompt } from './bank-window'
import { serverUrl, sessionToken } from './connection'
import { invoke } from './runtime'

// тот же период, что был по умолчанию у CLI (COLLECT_DAYS)
const COLLECT_DAYS = 30

/** Секрет сессии банка — в хранилище ОС через оболочку. */
export const osSessions: SessionStore = {
  async read(bank) {
    const raw = await invoke<string | null>('secret_session_read', { bank })
    return raw === null ? null : parseCredentials(raw)
  },
  async write(bank, credentials) {
    await invoke('secret_session_write', { bank, value: serializeCredentials(credentials) })
  },
}

const running = new Set<string>()

/**
 * Один сбор банка за раз. Кнопка на экране и так неактивна, но профиль банка
 * защищает не кнопка: два открытия одного профиля WebView2 разом затирают его.
 */
export async function runExclusive<T>(bank: string, work: () => Promise<T>): Promise<T> {
  if (running.has(bank)) throw new Error('Сбор этого банка уже идёт')
  running.add(bank)
  try {
    return await work()
  } finally {
    running.delete(bank)
  }
}

export function collectFromApp(bank: string, workspaceId: string): Promise<CollectSummary> {
  return runExclusive(bank, () => collect(bank, workspaceId))
}

async function collect(bank: string, workspaceId: string): Promise<CollectSummary> {
  const token = sessionToken()
  if (token === null) throw new Error('Нет входа в приложение')
  const plugin = await pluginFor(bank, { transport: async (name) => bankTransport(name) })
  return collectBank({
    plugin,
    sessions: osSessions,
    prompt: bankLoginPrompt(bank),
    app: { baseUrl: serverUrl(), workspaceId, authorization: `Session ${token}` },
    days: COLLECT_DAYS,
  })
}

export const forgetBank = (bank: string) => invoke<void>('bank_forget', { bank })
```

- [ ] **Step 3: прогон, коммит**

```bash
git add frontend/src/desktop
git commit -m "Сбор банка из окна приложения: плагин, секрет, окно входа и сессия приложения"
```

- [ ] **Step 4: проверка дефектом** — два прогона с откатом:
  1. в `read` вернуть `JSON.parse(raw)` вместо `parseCredentials(raw)` → FAIL «непригодная запись»;
  2. в `runExclusive` убрать `finally` → FAIL «второй сбор того же банка…» (последняя проверка).

---

### Задача 18: экран «Банки»

Что можно сделать (вид — минимальный, на усмотрение исполнителя в духе
соседних экранов Mantine):

- по строке на банк из `getBanks()`: «Собрать», итог последнего сбора этого
  сеанса, «Забыть доступ» (подтверждение вторым нажатием: кнопка меняет текст
  на «Точно забыть?»);
- «Собрать всё» — по очереди по банкам, у которых есть привязанный счёт
  (`getAccounts` → `bank_code === code && is_bank_linked`); сбой одного банка не
  останавливает остальные;
- во время сбора банка его кнопка неактивна; «Собрать всё» неактивна, пока идёт
  любой сбор;
- итог: по счёту — имя счёта (из `getAccounts` по `appAccountId`), «собрано N»,
  ссылка на `/import` при `importId`, текст `error`; ненулевые счётчики словами
  из `report.ts`; «Сессия: из хранилища / свежий вход»; при `unboundCount > 0` —
  «В банке ещё {accountsWord(n)} не ведётся» и ссылка на `/accounts`;
- ошибка банка целиком — «{Имя банка}: {текст}»; `AppHttpError` с `status === 401`
  → `queryClient.invalidateQueries({ queryKey: ['me'] })`, `AuthGuard` уведёт на вход;
- после сбора — `invalidateQueries` для `['accounts']` и `['imports']` (ключи
  сверить с соседними экранами: `grep -rn "queryKey: \[" frontend/src/pages`).

**Files:**
- Create: `frontend/src/pages/BanksPage.tsx`, `BanksPage.test.tsx`
- Modify: `frontend/src/main.tsx` (маршрут `/banks` только при `isDesktop()`)
- Modify: `frontend/src/AppLayout.tsx` (пункт «Банки» только при `isDesktop()`)

- [ ] **Step 1: тесты** — по образцу `AccountsPage.test.tsx` (обёртка
`MantineProvider` + `QueryClientProvider` + `MemoryRouter`, `vi.mock('../api/ledger')`),
плюс `vi.mock('../desktop/collector-host', () => ({ collectFromApp: vi.fn(), forgetBank: vi.fn() }))`.
Сценарии:
  1. «Собрать» у Сбера → `collectFromApp('sber', 'ws-1')`; итог с одним счётом
     `{ collected: 3, importId: 'imp-1', session: 'login' }` показывает «собрано 3»
     и «свежий вход»;
  2. пока промис `collectFromApp` не разрешён, кнопка «Собрать» Сбера `disabled`;
  3. «Собрать всё» при счетах с `bank_code: 'sber'` и `'alfa'` (оба
     `is_bank_linked: true`) и без счетов Т-Банка: вызывается для `sber` и `alfa`,
     не для `tbank`; первый вызов отклонён ошибкой «Сбер не отвечает» — второй
     всё равно вызван, текст ошибки на экране;
  4. «Забыть доступ» с первого нажатия `forgetBank` не зовёт, со второго — зовёт.

- [ ] **Step 2: красный прогон** — Expected: FAIL (экрана нет).

- [ ] **Step 3: реализация** — `BanksPage.tsx` по списку выше. Состояние
банков — `useState<Record<string, { running: boolean; summary?: CollectSummary; error?: string }>>`.
Маршрут в `main.tsx`: в `children` раскладки `...(isDesktop() ? [{ path: '/banks', element: <BanksPage /> }] : [])`.
Пункт меню в `AppLayout.tsx`: `LINKS` дополняется `{ to: '/banks', label: 'Банки' }` при `isDesktop()`.

- [ ] **Step 4: прогон** — `pnpm test && pnpm lint && pnpm build`.

- [ ] **Step 5: коммит**

```bash
git add frontend/src
git commit -m "Экран «Банки»: сбор по банку и всех привязанных, итоги и «забыть доступ»"
```

- [ ] **Step 6: проверка дефектом** — в «Собрать всё» заменить последовательный
цикл с `try/catch` на цикл без `catch` → FAIL сценарий 3. Откатить.

---

### Задача 19: прогон приложения на своём стенде

Не автоматизируется: окно WebView2 живое. Живые банки здесь **не трогаются** —
только приложение и отказы окна.

- [ ] **Step 1: стенд** — по `CLAUDE.md`, «Изоляция работы», имя проекта
`desktop`, свой `STAND_PORT` (например 18020), данные — копия основной базы
по той же инструкции.

- [ ] **Step 2: запуск**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd desktop && VITE_DEFAULT_SERVER=http://localhost:18020 pnpm tauri dev
```

- [ ] **Step 3: проверить и записать в отчёт задачи**
  - экран входа показывает «Адрес сервера» `http://localhost:18020`; вход
    проходит; после перезапуска приложения вход не нужен (токен из хранилища ОС);
  - «Счета», «Операции», «Импорт» работают так же, как в браузере (загрузка PDF — тоже);
  - «Банки» видны только здесь; в браузере на `http://localhost:5173` пункта нет;
  - в консоли разработчика окна (`Ctrl+Shift+I`):
    `await window.__TAURI_INTERNALS__.invoke('bank_request', { bank: 'sber', method: 'GET', url: 'https://example.com/', headers: {}, body: null })`
    → отказ «Не разрешено»;
    `await window.__TAURI_INTERNALS__.invoke('bank_window_open', { bank: 'sber', visible: true })`,
    затем `invoke('bank_window_goto', { bank: 'sber', url: 'https://example.com/' })` → отказ;
    `invoke('bank_window_goto', { bank: 'sber', url: 'https://online.sberbank.ru/' })` →
    страница входа Сбера **без ошибки сертификата**; `invoke('bank_window_close', { bank: 'sber' })`;
  - «Выйти» → экран входа; после перезапуска снова экран входа.

- [ ] **Step 4:** стенд не сносить до задачи 22 — он понадобится для живого прогона.

---

## Этап E. Уборка, документация, приёмка

### Задача 20: CLI и лишние обвязки удаляются

**Files:**
- Delete: `collector/src/runner/` целиком, `collector/src/http/public-fetch.ts`
  (им пользовался только `trust-anchor.ts`; сверить `grep -rn public-fetch collector/src`)
- Modify: `collector/package.json` — удалить скрипты `collect`, `forget`,
  зависимости `playwright`, `@napi-rs/keyring`; `tsx` оставить (`pnpm reference`)
- Modify: `collector/src/http/allowlist-client.ts` → `collector/src/http/bank-client.ts`,
  класс `BankClient` без поля `allowed` и без проверки списка
- Modify: `collector/src/plugins/*/client.ts` — удалить `*_ALLOWED`, константы путей оставить
- Modify: `collector/.oxlintrc.json` — текст правила про `fetch`: запросы к
  банку идут через транспорт, список адресов — в `desktop/src-tauri/src/banks.rs`
- Modify: `collector/.gitignore` — строку `profile/` удалить: профилей рядом с коллектором больше нет
- Modify: `collector/README.md` — переписать: что это теперь (ядро и плагины, работающие в приложении), разработка и тесты

Почему класс переименовывается: `AllowlistClient` без списка — имя, которое
врёт. Список теперь один, в Rust (спека, §3.1): копия в TypeScript разошлась бы
с ним и продолжала бы выглядеть гарантией.

- [ ] **Step 1:** удалить и переименовать; тесты `allowlist-client.test.ts` —
в `bank-client.test.ts` без тестов списка (их заменяют тесты `banks.rs`),
остальное (секрет в query/заголовке, разбор JSON без потерь, таймаут, текст
ошибки без секрета) — сохранить.
- [ ] **Step 2: прогон** — коллектор: `pnpm install && pnpm test && pnpm lint && pnpm build && pnpm reference`;
фронт: `pnpm test && pnpm build`; `git status docs/reference/generated` — пусто.
- [ ] **Step 3: коммит**

```bash
git add -A collector
git commit -m "CLI-коллектор удалён: сбор живёт в приложении, список адресов — в Rust"
```

- [ ] **Step 4: проверка дефектом** — вернуть в `pluginFor` для Сбера
`fetchTransport()` вместо `await deps.transport(name)` → FAIL
«транспорт запрашивается ровно для своего банка» (задача 4). Откатить.

---

### Задача 21: документация, CI и ворота

**Files:**
- Create: `docs/reference/desktop.md`
- Modify: `docs/reference/collector.md`, `docs/reference/README.md` (оглавление)
- Modify: `CLAUDE.md`, `README.md`, `docs/backlog.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `desktop/README.md`

- [ ] **Step 1: `docs/reference/desktop.md`** — бриф, а не черновик: документ
отвечает на вопросы ниже, и **рядом с каждым утверждением — `файл:строка`**,
написанные в момент утверждения, а не после:
  - какие команды есть у оболочки и что каждая проверяет до действия;
  - какому окну они доступны и почему окнам банков — никакие;
  - где лежат профили банков и секреты (каталог данных приложения, служба
    `aiccountant` в хранилище ОС, ключи `session:<банк>`, `app-token`);
  - чему доверяет каждый банк (HTTP и окно входа) и почему у Т-Банка иначе;
  - что делает «забыть доступ» и чего не делает;
  - почему `csp: null`;
  - в конце — раздел «Где код повёл себя не так, как подсказывала аналогия»:
    всё, что при написании удивило.
- [ ] **Step 2: `collector.md`** — разделы «Секреты», «Ограничение сетевых
обращений», «Якорь доверия» переписать под новое место (ссылки на
`desktop.md` вместо копий); «Реестр банков» — `pluginFor(name, { transport })`.
Сверить каждое оставшееся утверждение с кодом: описывает ли оно то, что код
делает **теперь**.
- [ ] **Step 3: `CLAUDE.md`**
  - «Структура репозитория»: `desktop/` — оболочка Tauri (Rust), несёт
    интерфейс и сбор; `collector/` — ядро и плагины банков, работают в окне приложения;
  - «Живой прогон коллектора — с разрешения владельца» переписать: живой
    прогон — сбор из приложения против настоящего банка; профили банков
    лежат в каталоге данных приложения, он определяется идентификатором
    `ru.aiccountant.desktop` и **общий для всех worktree**, поэтому два
    запущенных приложения затрут один профиль — спрашивать по-прежнему;
    `COLLECTOR_PROFILE_DIR` и `pnpm collect` из текста убрать.
- [ ] **Step 4: `README.md`** — этап: десктопный клиент на Tauri; как собрать
и запустить (ссылка на `desktop/README.md`); CLI больше нет.
- [ ] **Step 5: `docs/backlog.md`**
  - «Коллектор молчит о том, что открывал окно входа» — закрыть (итог сбора
    говорит, откуда сессия);
  - «Сбор запускается входом пользователя в приложение» — оболочка есть,
    остался сам автосбор;
  - новый пункт: основной стенд за Caddy отдаётся по `https://localhost` с
    самоподписанным корнем Caddy, и окно приложения ему не доверяет —
    приложение пока направляется на стенд с открытым портом.
- [ ] **Step 6: CI** — задание `desktop` в `.github/workflows/ci.yml`:

```yaml
  desktop:
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # generate_context! читает собранный фронт при компиляции
      - run: pnpm install --frozen-lockfile
        working-directory: frontend
      - run: pnpm build
        working-directory: frontend
      - run: cargo fmt --check
        working-directory: desktop/src-tauri
      - run: cargo clippy --all-targets -- -D warnings
        working-directory: desktop/src-tauri
      - run: cargo test
        working-directory: desktop/src-tauri
```

Шаги `pnpm/action-setup` и `setup-node` взять **в той же форме, что у задания
фронта** в этом же файле (версии и параметры сверить, не придумывать).
- [ ] **Step 7: ворота документации** — в регулярку `contract=` (`ci.yml`,
задание `docs-gate`) добавить
`|desktop/src-tauri/src/(banks|secrets|windows|http)\.rs`. Прогнать
`node scripts/docs-gate-stats.mjs` и записать в отчёт задачи, как часто
срабатывали ворота с меткой `docs-not-needed`.
- [ ] **Step 8: коммит**

```bash
git add docs CLAUDE.md README.md .github desktop/README.md
git commit -m "Документация десктопного клиента: справочник оболочки, правила живого прогона, CI"
```

---

### Задача 22: приёмка

- [ ] **Step 1: все проверки** — таблица «Команды проверки» целиком, плюс
`docker compose build` из корня (образ фронта со связанным коллектором).
- [ ] **Step 2: сводка дефектов** — в отчёт: каждая проверка дефектом из задач
1–20, какой тест упал. Если какой-то дефект тест не поймал — это находка, тест
дописать.
- [ ] **Step 3: ревью** — субагент `superpowers:code-reviewer` по всему диффу
ветки. В брифе обязательно: сверить `docs/reference/desktop.md`,
`collector.md`, `identity.md` с кодом — описывают ли они то, что код делает
теперь, а не делал раньше (`CLAUDE.md`, «Справочник и документация»).
- [ ] **Step 4: живой прогон — только с разрешения владельца.** Спросить;
получив «да»: на стенде задачи 19 собрать Т-Банк, Сбер и Альфу из приложения.
Записать: открывалось ли окно входа, итог (сколько собрано, импорт создан,
источник сессии), повторный сбор сразу после — сессия «из хранилища». Затем
«Забыть доступ» у одного банка и повторный сбор — окно входа открылось снова.
- [ ] **Step 5: уборка** — стенд `desktop` снести с томами (`CLAUDE.md`,
«Убирать за собой»); каталог `spike/` в worktree удалить.
- [ ] **Step 6: PR** — `git fetch origin`, `git log --oneline HEAD..origin/main`
пусто (иначе влить и прогнать заново), затем PR в `main`.
