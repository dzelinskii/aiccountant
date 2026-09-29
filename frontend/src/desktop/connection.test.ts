import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime', () => ({ isDesktop: () => true, invoke: invokeMock }))

// модуль хранит токен в переменной — каждый тест берёт его заново, чтобы
// состояние не переходило из теста в тест
async function freshConnection() {
  vi.resetModules()
  return import('./connection')
}

beforeEach(() => {
  localStorage.clear()
  invokeMock.mockReset()
  vi.stubEnv('VITE_DEFAULT_SERVER', 'http://default.test:8000')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

test('setServerUrl срезает пробелы и хвостовые слэши', async () => {
  const { setServerUrl, serverUrl } = await freshConnection()
  setServerUrl('  http://host:18000//  ')
  expect(serverUrl()).toBe('http://host:18000')
})

test('serverUrl без сохранённого значения отдаёт адрес из сборки', async () => {
  const { serverUrl } = await freshConnection()
  expect(serverUrl()).toBe('http://default.test:8000')
})

test('serverUrl отдаёт сохранённый адрес, а не умолчание', async () => {
  const { setServerUrl, serverUrl } = await freshConnection()
  setServerUrl('http://saved:1')
  expect(serverUrl()).toBe('http://saved:1')
})

test('до загрузки токена нет', async () => {
  const { sessionToken } = await freshConnection()
  expect(sessionToken()).toBeNull()
})

test('loadSession кладёт в память токен из хранилища', async () => {
  invokeMock.mockResolvedValueOnce('stored')
  const { loadSession, sessionToken } = await freshConnection()
  await loadSession()
  expect(invokeMock).toHaveBeenCalledWith('app_token_read')
  expect(sessionToken()).toBe('stored')
})

test('saveSession пишет токен в хранилище и держит его в памяти', async () => {
  invokeMock.mockResolvedValueOnce(undefined)
  const { saveSession, sessionToken } = await freshConnection()
  await saveSession('tok')
  expect(invokeMock).toHaveBeenCalledWith('app_token_write', { token: 'tok' })
  expect(sessionToken()).toBe('tok')
})

test('saveSession при сбое записи не меняет токен в памяти', async () => {
  invokeMock.mockResolvedValueOnce(undefined)
  const { saveSession, sessionToken } = await freshConnection()
  await saveSession('old')

  invokeMock.mockRejectedValueOnce(new Error('keyring недоступен'))
  await expect(saveSession('new')).rejects.toThrow('keyring недоступен')
  expect(sessionToken()).toBe('old')
})

test('clearSession стирает токен в хранилище и в памяти', async () => {
  invokeMock.mockResolvedValue(undefined)
  const { saveSession, clearSession, sessionToken } = await freshConnection()
  await saveSession('tok')
  await clearSession()
  expect(invokeMock).toHaveBeenLastCalledWith('app_token_clear')
  expect(sessionToken()).toBeNull()
})

test('clearSession при сбое хранилища не обнуляет токен в памяти', async () => {
  invokeMock.mockResolvedValueOnce(undefined)
  const { saveSession, clearSession, sessionToken } = await freshConnection()
  await saveSession('tok')

  invokeMock.mockRejectedValueOnce(new Error('keyring недоступен'))
  await expect(clearSession()).rejects.toThrow('keyring недоступен')
  expect(sessionToken()).toBe('tok')
})
