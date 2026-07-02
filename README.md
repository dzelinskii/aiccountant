# AIccountant

AI-помощник по личным финансам: чтение финансовых документов (выписки,
чеки, квитанции), сверка с транзакциями, аномалии, прогноз расходов.

Дизайн и дорожная карта: [спека](docs/superpowers/specs/2026-07-02-aiccountant-design.md).

## Структура

- `backend/` — FastAPI, модульный монолит (Python 3.12, uv)
- `frontend/` — React 19 + TypeScript + Vite (pnpm), PWA
- `infra/` — docker-compose, Caddy, деплой

## Запуск локально

    cp .env.example .env
    docker compose up --build

Приложение: https://localhost, API: https://localhost/api/health
(для localhost Caddy выпускает самоподписанный сертификат — браузер
предупредит, для curl нужен флаг `-k`).

## Разработка без Docker

    cd backend && uv run uvicorn app.main:app --reload    # API на :8000
    cd frontend && pnpm dev                                # Vite-прокси /api → :8000
