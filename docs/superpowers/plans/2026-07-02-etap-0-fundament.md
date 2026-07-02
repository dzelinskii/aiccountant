# Этап 0 «Фундамент» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Задеплоенный на VPS с TLS скелет AIccountant: FastAPI-бэкенд с health-эндпоинтом, React-фронт, docker-compose (Postgres, Redis, Caddy), зелёный CI и деплой по тегу.

**Architecture:** Монорепозиторий `backend/` (FastAPI, uv) + `frontend/` (Vite React TS, pnpm) + `infra/` (Caddy, compose). Caddy — единственная точка входа: раздаёт статику фронта и проксирует `/api/*` на бэкенд, TLS автоматический. CI на GitHub Actions, деплой — ssh + `docker compose up` по тегу `v*`.

**Tech Stack:** Python 3.12, uv, FastAPI, structlog, pytest, ruff, mypy; Node 22, pnpm, Vite, React 18, vitest; Docker Compose, Caddy 2, PostgreSQL 16, Redis 7, GitHub Actions.

---

## Что нужно от владельца до начала (вписать сюда)

- GitHub-репозиторий (публичный — это портфолио): `GITHUB_URL = ...`
- VPS с Ubuntu 22.04+ и root-доступом по SSH: `SERVER_IP = ...`
- Домен или поддомен, A-запись на `SERVER_IP`: `DOMAIN = ...`

Задачи 1–5 выполнимы без этого; задача 6 требует GitHub, задачи 7–8 — VPS и домен.

---

### Task 1: Каркас репозитория

**Files:**
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Создать .gitignore**

```gitignore
# Python
__pycache__/
*.pyc
.venv/
.mypy_cache/
.pytest_cache/
.ruff_cache/

# Node
node_modules/
dist/

# Окружение
.env

# IDE
.idea/
.vscode/
```

- [ ] **Step 2: Создать README-заготовку**

```markdown
# AIccountant

AI-помощник по личным финансам: чтение финансовых документов (выписки,
чеки, квитанции), сверка с транзакциями, аномалии, прогноз расходов.

Дизайн и дорожная карта: [спека](docs/superpowers/specs/2026-07-02-aiccountant-design.md).

## Структура

- `backend/` — FastAPI, модульный монолит (Python 3.12, uv)
- `frontend/` — React 18 + TypeScript + Vite (pnpm), PWA
- `infra/` — docker-compose, Caddy, деплой

## Запуск локально

    cp .env.example .env
    docker compose up --build

Приложение: http://localhost, API: http://localhost/api/health
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore README.md
git commit -m "Этап 0: каркас репозитория"
```

---

### Task 2: Backend — проект uv и тулинг

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/app/__init__.py`

- [ ] **Step 1: Создать backend/pyproject.toml**

```toml
[project]
name = "aiccountant-backend"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi",
    "uvicorn[standard]",
    "structlog",
]

[dependency-groups]
dev = [
    "pytest",
    "pytest-asyncio",
    "httpx",
    "ruff",
    "mypy",
]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM"]

[tool.mypy]
strict = true
packages = ["app", "tests"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 2: Создать пустой пакет приложения**

```bash
mkdir -p backend/app backend/tests
touch backend/app/__init__.py backend/tests/__init__.py
```

- [ ] **Step 3: Установить зависимости**

Run: `cd backend && uv sync`
Expected: создан `.venv/` и `uv.lock`, зависимости установлены без ошибок.

- [ ] **Step 4: Проверить тулинг на пустом проекте**

Run: `cd backend && uv run ruff check . && uv run mypy`
Expected: `All checks passed!` и `Success: no issues found`.

- [ ] **Step 5: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock backend/app backend/tests
git commit -m "Этап 0: backend-проект на uv, ruff и mypy настроены"
```

---

### Task 3: Backend — health-эндпоинт (TDD)

**Files:**
- Test: `backend/tests/test_health.py`
- Create: `backend/app/logging.py`
- Create: `backend/app/main.py`

- [ ] **Step 1: Написать падающий тест**

`backend/tests/test_health.py`:

```python
from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    client = TestClient(app)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd backend && uv run pytest -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 3: Реализовать логирование и приложение**

`backend/app/logging.py`:

```python
import logging

import structlog


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    )
```

`backend/app/main.py`:

```python
from fastapi import FastAPI

from app.logging import configure_logging

configure_logging()

app = FastAPI(title="AIccountant")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `cd backend && uv run pytest -v`
Expected: `1 passed`.

- [ ] **Step 5: Линт и типы**

Run: `cd backend && uv run ruff check . && uv run ruff format . && uv run mypy`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add backend/app backend/tests
git commit -m "Этап 0: health-эндпоинт и структурное логирование"
```

---

### Task 4: Frontend — скелет Vite + страница статуса

**Files:**
- Create: `frontend/` (скаффолд Vite)
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/App.test.tsx`
- Modify: `frontend/package.json` (скрипт `test`)

- [ ] **Step 1: Сгенерировать скаффолд**

Run (из корня репозитория):

```bash
pnpm create vite frontend --template react-ts
cd frontend && pnpm install
```

Expected: каталог `frontend/` со стандартной структурой Vite (src, eslint-конфиг, tsconfig).

- [ ] **Step 2: Настроить dev-прокси и окружение тестов**

Заменить `frontend/vite.config.ts` целиком:

```ts
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8000' } },
  test: { environment: 'jsdom' },
})
```

- [ ] **Step 3: Установить vitest и testing-library**

```bash
cd frontend
pnpm add -D vitest jsdom @testing-library/react
```

В `frontend/package.json` в `scripts` добавить:

```json
"test": "vitest run"
```

- [ ] **Step 4: Написать падающий тест**

`frontend/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import App from './App'

test('показывает название и статус API', () => {
  render(<App />)
  expect(screen.getByText('AIccountant')).toBeDefined()
  expect(screen.getByText(/API/)).toBeDefined()
})
```

- [ ] **Step 5: Убедиться, что тест падает**

Run: `cd frontend && pnpm test`
Expected: FAIL — в скаффолдном `App.tsx` нет текста `AIccountant`.

- [ ] **Step 6: Реализовать страницу статуса**

Заменить `frontend/src/App.tsx` целиком:

```tsx
import { useEffect, useState } from 'react'

export default function App() {
  const [status, setStatus] = useState('…')

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setStatus(d.status))
      .catch(() => setStatus('недоступен'))
  }, [])

  return (
    <main>
      <h1>AIccountant</h1>
      <p>API: {status}</p>
    </main>
  )
}
```

Удалить неиспользуемые `frontend/src/App.css` и импорт стилей, если скаффолд их создал (оставить `index.css`).

- [ ] **Step 7: Тест, линт, сборка**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: тест проходит, линт чистый, `dist/` собирается.

- [ ] **Step 8: Commit**

```bash
git add frontend
git commit -m "Этап 0: frontend-скелет со страницей статуса API"
```

---

### Task 5: Docker и docker-compose

**Files:**
- Create: `backend/Dockerfile`
- Create: `frontend/Dockerfile`
- Create: `infra/Caddyfile`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `.dockerignore`
- Create: `backend/.dockerignore`

- [ ] **Step 1: Dockerfile бэкенда**

`backend/Dockerfile`:

```dockerfile
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY app ./app
CMD ["/app/.venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Dockerfile фронта + Caddy**

Контекст сборки — корень репозитория (см. compose ниже), чтобы образ видел
и `frontend/`, и `infra/Caddyfile`.

`frontend/Dockerfile`:

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ .
RUN pnpm build

FROM caddy:2
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
```

- [ ] **Step 3: Caddyfile**

`infra/Caddyfile`:

```
{$DOMAIN:localhost} {
	encode gzip

	handle /api/* {
		reverse_proxy backend:8000
	}

	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 4: docker-compose.yml и .env.example**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: aiccountant
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
      POSTGRES_DB: aiccountant
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aiccountant"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7

  backend:
    build: ./backend
    environment:
      DATABASE_URL: postgresql+asyncpg://aiccountant:${POSTGRES_PASSWORD}@postgres:5432/aiccountant
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - postgres
      - redis

  caddy:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    ports:
      - "80:80"
      - "443:443"
    environment:
      DOMAIN: ${DOMAIN:-localhost}
    volumes:
      - caddy_data:/data
    depends_on:
      - backend

volumes:
  pg_data:
  caddy_data:
```

`.env.example`:

```env
POSTGRES_PASSWORD=change-me
DOMAIN=localhost
```

Без `.dockerignore` команда `COPY frontend/ .` затаскивает в образ локально
установленный `node_modules` (с нативными бинарниками хост-ОС), затирая
Linux-установку из `pnpm install` — сборка падает. Аналогично `.venv`
раздувает контекст сборки бэкенда.

`.dockerignore` (корень — контекст сборки caddy):

```
.git
docs
.env
**/node_modules
**/dist
**/.venv
**/__pycache__
**/.mypy_cache
**/.pytest_cache
**/.ruff_cache
```

`backend/.dockerignore` (контекст сборки бэкенда):

```
.venv
__pycache__
.mypy_cache
.pytest_cache
.ruff_cache
```

- [ ] **Step 5: Локальная проверка**

```bash
cp .env.example .env
docker compose up -d --build
```

Run: `curl -k https://localhost/api/health`
Expected: `{"status":"ok"}` (`-k` — потому что для localhost Caddy выпускает
самоподписанный сертификат).

Run: `curl -k https://localhost/`
Expected: HTML со страницей приложения.

- [ ] **Step 6: Остановить и закоммитить**

```bash
docker compose down
git add backend/Dockerfile frontend/Dockerfile infra/Caddyfile docker-compose.yml .env.example .dockerignore backend/.dockerignore
git commit -m "Этап 0: Docker-образы, compose и Caddy"
```

---

### Task 6: CI на GitHub Actions

Требуется GitHub-репозиторий (`GITHUB_URL` из прелюдии).

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Подключить remote (если ещё не)**

```bash
git remote add origin <GITHUB_URL>
git push -u origin main
```

- [ ] **Step 2: Создать workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - run: uv sync
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run mypy
      - run: uv run pytest

  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          package_json_file: frontend/package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cp .env.example .env
      - run: docker compose build
```

Примечание: `pnpm/action-setup@v4` читает версию pnpm из поля `packageManager`
в `frontend/package.json` — убедиться, что оно там есть (скаффолд Vite его
добавляет; если нет — `cd frontend && corepack use pnpm@latest`). Параметр
`package_json_file` обязателен: `defaults.run.working-directory` действует
только на run-шаги, uses-шаги ищут package.json в корне репозитория.

- [ ] **Step 3: Запушить и проверить**

```bash
git add .github/workflows/ci.yml
git commit -m "Этап 0: CI — линт, типы, тесты, сборка образов"
git push
```

Открыть Actions в GitHub.
Expected: все три джобы зелёные.

---

### Task 7: Деплой на VPS с TLS

Требуются `SERVER_IP` и `DOMAIN` с A-записью на него (прелюдия). DNS должен
резолвиться до запуска, иначе Caddy не получит сертификат.

**Files:** нет изменений в репозитории (серверная настройка).

- [ ] **Step 1: Подготовка сервера (однократно, под root)**

```bash
ssh root@<SERVER_IP>

apt-get update && apt-get install -y git ufw
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
```

- [ ] **Step 2: Первый деплой (под deploy)**

```bash
ssh deploy@<SERVER_IP>

git clone <GITHUB_URL> ~/aiccountant
cd ~/aiccountant
cp .env.example .env
```

Отредактировать `.env`: сильный `POSTGRES_PASSWORD`, `DOMAIN=<DOMAIN>`.

```bash
docker compose up -d --build
```

- [ ] **Step 3: Проверка**

Run (с локальной машины): `curl https://<DOMAIN>/api/health`
Expected: `{"status":"ok"}`, сертификат валидный (без `-k`).

Открыть `https://<DOMAIN>/` в браузере.
Expected: страница «AIccountant, API: ok».

---

### Task 8: Деплой по тегу

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Ключ деплоя**

На локальной машине:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "aiccountant-deploy"
ssh deploy@<SERVER_IP> "cat >> ~/.ssh/authorized_keys" < deploy_key.pub
```

В GitHub → Settings → Secrets and variables → Actions добавить:
- `DEPLOY_HOST` = `<SERVER_IP>`
- `DEPLOY_SSH_KEY` = содержимое файла `deploy_key` (приватный ключ)

Удалить локальные файлы `deploy_key`, `deploy_key.pub` после добавления.

- [ ] **Step 2: Workflow деплоя**

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    tags: ["v*"]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: deploy
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd ~/aiccountant
            git fetch --all --tags
            git checkout ${{ github.ref_name }}
            docker compose up -d --build
```

- [ ] **Step 3: Commit и проверка тегом**

```bash
git add .github/workflows/deploy.yml
git commit -m "Этап 0: деплой по тегу"
git push
git tag v0.0.1 && git push origin v0.0.1
```

Открыть Actions.
Expected: джоба Deploy зелёная; `curl https://<DOMAIN>/api/health` отвечает.

---

### Task 9: Закрытие вехи

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Дополнить README**

Добавить в начало `README.md` (после заголовка):

```markdown
[![CI](<GITHUB_URL>/actions/workflows/ci.yml/badge.svg)](<GITHUB_URL>/actions/workflows/ci.yml)

Демо: https://<DOMAIN>
```

И раздел в конец:

```markdown
## Деплой

Деплой происходит по git-тегу `v*` (GitHub Actions → ssh → `docker compose up`).
Вход в приложение — Caddy: TLS автоматически, статика фронта + прокси `/api/*`.
```

- [ ] **Step 2: Commit и деплой вехи**

```bash
git add README.md
git commit -m "Этап 0: README — бейдж CI и демо-URL"
git push
git tag v0.1.0 && git push origin v0.1.0
```

Expected: деплой прошёл, `https://<DOMAIN>` живёт. **Веха этапа 0 закрыта.**

---

## Definition of done (из спеки)

- «Hello» живёт по URL с валидным TLS — Task 7/8.
- Пайплайн зелёный — Task 6.
- Этап описан в README — Task 9.
