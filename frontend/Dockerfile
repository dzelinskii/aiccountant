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
