import { serverUrl, sessionToken } from '../desktop/connection'
import { isDesktop } from '../desktop/runtime'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, detailToMessage(body?.detail) ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// FastAPI отдаёт detail строкой (наши HTTPException) либо массивом объектов
// (ошибки валидации Pydantic, 422) — приводим к читаемой строке
export function detailToMessage(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail.map((e) => (e as { msg?: string }).msg ?? String(e)).join('; ')
  }
  return undefined
}
