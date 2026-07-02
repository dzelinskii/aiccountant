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
