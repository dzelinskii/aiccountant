import { beforeEach, expect, test, vi } from 'vitest'
import { login, logout, register } from './auth'

const desktop = vi.hoisted(() => ({ on: false }))
const connection = vi.hoisted(() => ({
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  sessionToken: vi.fn(() => null),
  serverUrl: vi.fn(() => 'http://srv.test'),
}))
vi.mock('../desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('../desktop/connection', () => connection)

const fetchMock = vi.fn()

function reply(status: number, body?: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), { status }),
  )
}

function sentBody(): unknown {
  return JSON.parse(fetchMock.mock.calls[0]![1].body as string)
}

beforeEach(() => {
  desktop.on = false
  fetchMock.mockReset()
  connection.saveSession.mockReset()
  connection.clearSession.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

test('в приложении вход шлёт client=app и сохраняет выданную сессию', async () => {
  desktop.on = true
  reply(200, { id: 'u', email: 'a@b.c', session_token: 'tok' })
  await login('a@b.c', 'pw')
  expect(sentBody()).toEqual({ email: 'a@b.c', password: 'pw', client: 'app' })
  expect(connection.saveSession).toHaveBeenCalledWith('tok')
})

test('в браузере вход шлёт client=browser и хранилище не трогает', async () => {
  reply(200, { id: 'u', email: 'a@b.c', session_token: null })
  await login('a@b.c', 'pw')
  expect(sentBody()).toEqual({ email: 'a@b.c', password: 'pw', client: 'browser' })
  expect(connection.saveSession).not.toHaveBeenCalled()
})

test('в приложении ответ без session_token — отказ, а не вход без сессии', async () => {
  desktop.on = true
  reply(200, { id: 'u', email: 'a@b.c', session_token: null })
  await expect(login('a@b.c', 'pw')).rejects.toThrow('Сервер не выдал сессию приложению')
  expect(connection.saveSession).not.toHaveBeenCalled()
})

test('в приложении регистрация шлёт client=app и сохраняет сессию', async () => {
  desktop.on = true
  reply(200, { id: 'u', email: 'a@b.c', session_token: 'tok' })
  await register('a@b.c', 'pw')
  expect(fetchMock.mock.calls[0]![0]).toBe('http://srv.test/api/auth/register')
  expect(sentBody()).toEqual({ email: 'a@b.c', password: 'pw', client: 'app' })
  expect(connection.saveSession).toHaveBeenCalledWith('tok')
})

test('в приложении регистрация без session_token — отказ', async () => {
  desktop.on = true
  reply(200, { id: 'u', email: 'a@b.c', session_token: null })
  await expect(register('a@b.c', 'pw')).rejects.toThrow('Сервер не выдал сессию приложению')
  expect(connection.saveSession).not.toHaveBeenCalled()
})

test('в браузере регистрация шлёт client=browser', async () => {
  reply(200, { id: 'u', email: 'a@b.c', session_token: null })
  await register('a@b.c', 'pw')
  expect(sentBody()).toEqual({ email: 'a@b.c', password: 'pw', client: 'browser' })
  expect(connection.saveSession).not.toHaveBeenCalled()
})

test('в приложении выход стирает сессию', async () => {
  desktop.on = true
  reply(204)
  await logout()
  expect(connection.clearSession).toHaveBeenCalledOnce()
})

test.each([401, 500])(
  'в приложении сессия стирается и при ответе сервера %i, ошибка не глотается',
  async (status) => {
    desktop.on = true
    reply(status, { detail: 'нет' })
    await expect(logout()).rejects.toMatchObject({ status })
    expect(connection.clearSession).toHaveBeenCalledOnce()
  },
)

test('в приложении сессия стирается и когда сервер недоступен', async () => {
  desktop.on = true
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await expect(logout()).rejects.toThrow('Failed to fetch')
  expect(connection.clearSession).toHaveBeenCalledOnce()
})

test('в браузере выход хранилище не трогает', async () => {
  reply(204)
  await logout()
  expect(connection.clearSession).not.toHaveBeenCalled()
})
