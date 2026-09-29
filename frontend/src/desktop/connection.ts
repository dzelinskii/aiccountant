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

// токен в памяти не должен опережать хранилище: при сбое записи остаётся прежний
export async function saveSession(value: string): Promise<void> {
  await invoke('app_token_write', { token: value })
  token = value
}

export async function clearSession(): Promise<void> {
  await invoke('app_token_clear')
  token = null
}
