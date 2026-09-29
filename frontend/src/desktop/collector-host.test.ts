import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ token: 'tok' as string | null }))
const invoke = vi.hoisted(() => vi.fn())
const collectBank = vi.hoisted(() => vi.fn())
const pluginFor = vi.hoisted(() => vi.fn())

vi.mock('./runtime', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('./connection', () => ({ serverUrl: () => 'http://srv.test', sessionToken: () => state.token }))
// у подмен есть метка банка: тест видит, что в хост попало именно его
vi.mock('./bank-transport', () => ({ bankTransport: (bank: string) => ({ kind: 'transport', bank }) }))
vi.mock('./bank-window', () => ({ bankLoginPrompt: (bank: string) => ({ kind: 'prompt', bank }) }))
vi.mock('aiccountant-collector/src/app', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collectBank: (...args: unknown[]) => collectBank(...args),
  pluginFor: (...args: unknown[]) => pluginFor(...args),
}))

import { collectFromApp, forgetBank, osSessions, runExclusive } from './collector-host'

const BUSY = /уже идёт работа/

beforeEach(() => {
  invoke.mockReset()
  collectBank.mockReset()
  pluginFor.mockReset()
  state.token = 'tok'
})

test('секрета нет — null', async () => {
  invoke.mockResolvedValueOnce(null)
  expect(await osSessions.read('sber')).toBeNull()
  expect(invoke).toHaveBeenCalledWith('secret_session_read', { bank: 'sber' })
})

test('непригодная запись — «секрета нет», а не сбой', async () => {
  invoke.mockResolvedValueOnce('не json')
  expect(await osSessions.read('sber')).toBeNull()
})

test('секрет пишется сериализованным и читается обратно', async () => {
  const credentials = { kind: 'header', name: 'Cookie', value: 'c' } as const
  await osSessions.write('sber', credentials)
  const [command, args] = invoke.mock.calls[0] as [string, { bank: string; value: string }]
  expect(command).toBe('secret_session_write')
  expect(args.bank).toBe('sber')
  invoke.mockResolvedValueOnce(args.value)
  expect(await osSessions.read('sber')).toEqual(credentials)
})

test('второй сбор того же банка, пока идёт первый, отвергается: профиль банка не открывают дважды', async () => {
  let release: () => void = () => {}
  invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const first = runExclusive('sber', () => invoke('bank_window_open'))
  try {
    await expect(runExclusive('sber', async () => undefined)).rejects.toThrow(BUSY)
    await expect(runExclusive('alfa', async () => 'другой банк')).resolves.toBe('другой банк')
  } finally {
    release()
    await first
  }
  await expect(runExclusive('sber', async () => 'снова можно')).resolves.toBe('снова можно')
})

test('банк освобождается и после отказа работы, а её ошибка доходит до вызывающего', async () => {
  await expect(
    runExclusive('sber', async () => {
      throw new Error('банк не ответил')
    }),
  ).rejects.toThrow('банк не ответил')
  await expect(runExclusive('sber', async () => 'снова можно')).resolves.toBe('снова можно')
})

test('«забыть банк» идёт через ту же защиту: пока идёт сбор, отвергается', async () => {
  let release: () => void = () => {}
  const collecting = runExclusive('sber', () => new Promise<void>((resolve) => (release = resolve)))
  try {
    await expect(forgetBank('sber')).rejects.toThrow(BUSY)
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    release()
    await collecting
  }
})

test('сбор, пока идёт «забыть банк», отвергается', async () => {
  let release: () => void = () => {}
  invoke.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
  const forgetting = forgetBank('sber')
  try {
    await expect(collectFromApp('sber', 'ws-1')).rejects.toThrow(BUSY)
    expect(collectBank).not.toHaveBeenCalled()
  } finally {
    release()
    await forgetting
  }
  expect(invoke).toHaveBeenCalledWith('bank_forget', { bank: 'sber' })
})

test('«забыть банк» освобождает банк и после отказа оболочки', async () => {
  invoke.mockRejectedValueOnce(new Error('профиль занят'))
  await expect(forgetBank('sber')).rejects.toThrow('профиль занят')
  invoke.mockResolvedValueOnce(undefined)
  await expect(forgetBank('sber')).resolves.toBeUndefined()
})

test('без входа в приложение сбор отвергается до окна банка и до секрета', async () => {
  state.token = null
  await expect(collectFromApp('sber', 'ws-1')).rejects.toThrow('Нет входа в приложение')
  expect(invoke).not.toHaveBeenCalled()
  expect(pluginFor).not.toHaveBeenCalled()
  expect(collectBank).not.toHaveBeenCalled()
})

test('хост сбора: приложение, сессия, период, плагин и транспорт именно этого банка', async () => {
  const plugin = { name: 'alfa' }
  const summary = { bank: 'alfa', session: 'stored', accounts: [], unboundCount: 0 }
  pluginFor.mockResolvedValueOnce(plugin)
  collectBank.mockResolvedValueOnce(summary)

  await expect(collectFromApp('alfa', 'ws-1')).resolves.toBe(summary)

  expect(pluginFor).toHaveBeenCalledTimes(1)
  const [name, options] = pluginFor.mock.calls[0] as [string, { transport: (bank: string) => Promise<unknown> }]
  expect(name).toBe('alfa')
  expect(await options.transport('alfa')).toEqual({ kind: 'transport', bank: 'alfa' })

  expect(collectBank).toHaveBeenCalledTimes(1)
  const [host] = collectBank.mock.calls[0] as [Record<string, unknown>]
  expect(host).toEqual({
    plugin,
    sessions: osSessions,
    prompt: { kind: 'prompt', bank: 'alfa' },
    app: { baseUrl: 'http://srv.test', workspaceId: 'ws-1', authorization: 'Session tok' },
    days: 30,
  })
})

test('после сбора, в том числе неудачного, банк можно собирать снова', async () => {
  pluginFor.mockResolvedValue({ name: 'sber' })
  collectBank.mockRejectedValueOnce(new Error('банк недоступен')).mockResolvedValueOnce({ bank: 'sber' })
  await expect(collectFromApp('sber', 'ws-1')).rejects.toThrow('банк недоступен')
  await expect(collectFromApp('sber', 'ws-1')).resolves.toEqual({ bank: 'sber' })
})
