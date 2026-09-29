import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const desktop = { on: false, token: 'tok' as string | null }
vi.mock('../desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('../desktop/connection', () => ({
  serverUrl: () => 'http://localhost:18000',
  sessionToken: () => desktop.token,
}))

import { api, apiFetch } from './client'
import { startImport } from './imports'

const fetchMock = vi.fn(async () => new Response('{"import_id":"i1"}'))

function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls[0] as unknown as [string, RequestInit]
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockClear()
  desktop.on = false
  desktop.token = 'tok'
})

test('в браузере — относительный адрес и cookie своего origin, без заголовка сессии', async () => {
  await apiFetch('/api/me')
  const [url, init] = lastCall()
  expect(url).toBe('/api/me')
  expect(init.credentials).toBe('same-origin')
  expect(new Headers(init.headers).has('Authorization')).toBe(false)
})

test('в приложении — полный адрес сервера и сессия заголовком, cookie не шлются', async () => {
  desktop.on = true
  await apiFetch('/api/me', { headers: { 'Content-Type': 'application/json' } })
  const [url, init] = lastCall()
  expect(url).toBe('http://localhost:18000/api/me')
  expect(init.credentials).toBe('omit')
  const headers = new Headers(init.headers)
  expect(headers.get('Authorization')).toBe('Session tok')
  expect(headers.get('Content-Type')).toBe('application/json')
})

test('в приложении без токена заголовка Authorization нет', async () => {
  desktop.on = true
  desktop.token = null
  await apiFetch('/api/me')
  const [, init] = lastCall()
  expect(new Headers(init.headers).has('Authorization')).toBe(false)
})

test('api() в приложении ходит на полный адрес с сессией и JSON-заголовком', async () => {
  desktop.on = true
  await api('/api/me')
  const [url, init] = lastCall()
  expect(url).toBe('http://localhost:18000/api/me')
  expect(init.credentials).toBe('omit')
  const headers = new Headers(init.headers)
  expect(headers.get('Authorization')).toBe('Session tok')
  expect(headers.get('Content-Type')).toBe('application/json')
})

test('api() в браузере остаётся на относительном адресе', async () => {
  await api('/api/me')
  const [url, init] = lastCall()
  expect(url).toBe('/api/me')
  expect(init.credentials).toBe('same-origin')
})

test('startImport в приложении — полный адрес, сессия заголовком, без Content-Type', async () => {
  desktop.on = true
  const file = new File(['a,b'], 'ops.csv')
  await startImport('ws1', 'acc1', file)
  const [url, init] = lastCall()
  expect(url).toBe('http://localhost:18000/api/imports?workspace_id=ws1&account_id=acc1')
  expect(init.method).toBe('POST')
  expect(init.credentials).toBe('omit')
  const headers = new Headers(init.headers)
  expect(headers.get('Authorization')).toBe('Session tok')
  // boundary у multipart выставляет браузер — свой Content-Type его сломал бы
  expect(headers.has('Content-Type')).toBe(false)
  expect(init.body).toBeInstanceOf(FormData)
})

test('startImport в браузере — относительный адрес и cookie', async () => {
  await startImport('ws1', 'acc1', new File(['a'], 'ops.csv'))
  const [url, init] = lastCall()
  expect(url).toBe('/api/imports?workspace_id=ws1&account_id=acc1')
  expect(init.credentials).toBe('same-origin')
})
