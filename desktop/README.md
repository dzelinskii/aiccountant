# Десктопное приложение

Оболочка Tauri 2 для Windows, которая показывает React-фронт из `../frontend`.
Где лежат профили банков и секреты — допишут, когда появятся окна входа
и хранилище секретов; пока здесь только окно с фронтом.

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
Запускать надо из `desktop/`: там `package.json` со скриптом `tauri`.
Относительные пути в `beforeDevCommand` и `beforeBuildCommand`
(`pnpm --dir ../frontend`) проверены запуском из `desktop/`.

Для `cargo build` без `tauri dev` фронт должен быть собран заранее
(`pnpm --dir ../frontend build`): `tauri::generate_context!` читает
`frontendDist` при компиляции.

## Грабли

Разведка и причины решений — `../docs/superpowers/specs/2026-09-29-desktop-shell-recon.md`,
§3.6. Сверх неё:

- собранный фронт нужен до компиляции оболочки (см. «Запуск»);
- иконки генерируются с `--fit contain`: `pnpm tauri icon <файл> --fit contain`,
  без флага Tauri отказывает на неквадратном исходнике.
