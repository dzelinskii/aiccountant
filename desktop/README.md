# Десктопное приложение

Приложение Tauri 2 для Windows: показывает React-фронт из `../frontend` и
собирает операции из банков ядром коллектора из `../collector`. Что оболочка
гарантирует — команды, окна банков, секреты, доверие к УЦ, где лежат профили и
секреты — в [docs/reference/desktop.md](../docs/reference/desktop.md).

## Требования

- Rust через [rustup](https://rustup.rs) (`~/.cargo/bin` должен быть в `PATH`).
- MSVC и Windows SDK — из Visual Studio Build Tools (нужны для первой сборки).
- WebView2 — уже есть в Windows 10/11.
- Node и pnpm — те же, что для фронта.

## Запуск для разработки

```bash
pnpm --dir ../frontend install --frozen-lockfile   # один раз
pnpm install                                       # один раз, в desktop/
VITE_DEFAULT_SERVER=http://localhost:18000 pnpm tauri dev
```

`pnpm tauri dev` сам поднимает Vite (`beforeDevCommand`) и открывает окно.
Запускать надо из `desktop/`: там `package.json` со скриптом `tauri`.
Относительные пути в `beforeDevCommand` и `beforeBuildCommand`
(`pnpm --dir ../frontend`) проверены запуском из `desktop/`.

`VITE_DEFAULT_SERVER` — адрес сервера, который экран входа предложит по
умолчанию; без переменной это `http://localhost:8000`. Адрес вшивается при
сборке фронта, а поменять его можно и на экране входа — приложение запомнит
последний. В PowerShell переменная задаётся так:
`$env:VITE_DEFAULT_SERVER = "http://localhost:18000"; pnpm tauri dev`.

Направлять приложение нужно на стенд с открытым портом бэкенда
(`docker-compose.stand.yml`): основной стенд за Caddy отдаётся по
`https://localhost` с самоподписанным сертификатом, и окно приложения ему не
доверяет (`../docs/backlog.md`).

CSP окна проверяется только на собранном приложении — почему, в
`docs/reference/desktop.md`, «CSP окна приложения».

## Сборка

```bash
pnpm tauri build --no-bundle
```

Сборка сама собирает фронт (`beforeBuildCommand`), и `VITE_DEFAULT_SERVER`
действует так же, как в режиме разработки. Результат —
`src-tauri/target/release/aiccountant-desktop.exe`; установщика нет
(`bundle.active` выключен в `tauri.conf.json`).

## Проверки

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo test -- --ignored   # живые: пишут в Credential Manager и ходят в сеть
```

Для `cargo build`, `clippy` и `test` без `tauri dev` фронт должен быть собран
заранее (`pnpm --dir ../frontend build`): `tauri::generate_context!` читает
`frontendDist` при компиляции.

## Грабли

Разведка и причины решений — `../docs/superpowers/specs/2026-09-29-desktop-shell-recon.md`,
§3.6; что удивило при написании оболочки — `docs/reference/desktop.md`, «Где
код повёл себя не так, как подсказывала аналогия». Сверх них:

- собранный фронт нужен до компиляции оболочки (см. «Проверки»);
- иконки генерируются с `--fit contain`: `pnpm tauri icon <файл> --fit contain`,
  без флага Tauri отказывает на неквадратном исходнике.
