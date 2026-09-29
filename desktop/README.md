# Десктопное приложение

Оболочка Tauri 2 для Windows, которая показывает React-фронт из `../frontend`.
Профили банков и хранилище секретов появятся в этом каталоге позже — здесь
пока только окно с фронтом.

## Требования

- Rust через [rustup](https://rustup.rs) (`~/.cargo/bin` должен быть в `PATH`).
- MSVC и Windows SDK — из Visual Studio Build Tools (нужны для первой сборки).
- WebView2 — уже есть в Windows 10/11.
- Node и pnpm — те же, что для фронта.

## Запуск

```bash
pnpm --dir ../frontend install --frozen-lockfile   # один раз
pnpm install                                       # один раз, в desktop/
pnpm tauri dev
```

`pnpm tauri dev` сам поднимает Vite (`beforeDevCommand`) и открывает окно.
Пути в `tauri.conf.json` (`pnpm --dir ../frontend`) считаются от `desktop/`,
поэтому команду запускают из этого каталога.

Для `cargo build` без `tauri dev` фронт должен быть собран заранее
(`pnpm --dir ../frontend build`): `tauri::generate_context!` читает
`frontendDist` при компиляции.

## Грабли

Разведка и причины решений — `../docs/superpowers/specs/2026-09-29-desktop-shell-recon.md`,
§3.6. Коротко: собранный фронт нужен до компиляции оболочки; иконки —
`pnpm tauri icon <файл> --fit contain`; команды приложения вызываются
из окна только при наличии в `build.rs` и разрешения `allow-*` в
`capabilities/default.json`.
