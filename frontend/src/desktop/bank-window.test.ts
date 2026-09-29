import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('./runtime', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { bankLoginPrompt } from './bank-window'

beforeEach(() => invoke.mockReset())
afterEach(() => vi.restoreAllMocks())

function fakeTiming() {
  let clock = 0
  let reads = 0
  const waits: number[] = []
  return {
    // Опрос без дедлайна или без паузы крутился бы в микрозадачах и не дал бы
    // сработать таймауту vitest, а воркер упал бы по памяти без имени теста:
    // число обращений к часам ограничено, и такой сбой — обычный FAIL
    now: () => {
      if (++reads > 100) throw new Error('ожидание не ограничено ни паузой, ни дедлайном')
      return clock
    },
    wait: async (ms: number) => {
      waits.push(ms)
      clock += ms
    },
    waits,
  }
}

function commandsOf(): string[] {
  return invoke.mock.calls.map((call) => call[0] as string)
}

test('окно открывается видимым, закрывается и после ошибки', async () => {
  invoke.mockResolvedValue(undefined)
  const prompt = bankLoginPrompt('alfa', fakeTiming())
  await expect(prompt.withBrowser(async () => { throw new Error('сбой') })).rejects.toThrow('сбой')
  expect(invoke).toHaveBeenCalledWith('bank_window_open', { bank: 'alfa', visible: true })
  expect(invoke).toHaveBeenLastCalledWith('bank_window_close', { bank: 'alfa' })
})

test('headless — окно открывается невидимым', async () => {
  invoke.mockResolvedValue(undefined)
  await bankLoginPrompt('tbank', fakeTiming()).withBrowser(async () => undefined, { headless: true })
  expect(invoke).toHaveBeenCalledWith('bank_window_open', { bank: 'tbank', visible: false })
})

test('после успешного use окно закрывается, результат возвращается', async () => {
  invoke.mockResolvedValue(undefined)
  const result = await bankLoginPrompt('sber', fakeTiming()).withBrowser(async () => 42)
  expect(result).toBe(42)
  expect(commandsOf()).toEqual(['bank_window_open', 'bank_window_close'])
  expect(invoke).toHaveBeenLastCalledWith('bank_window_close', { bank: 'sber' })
})

test('goto, clearCookie и cookies уходят в свои команды', async () => {
  invoke.mockImplementation(async (command: string) =>
    command === 'bank_window_cookies' ? [{ name: 'sid', value: 'v' }] : undefined,
  )
  const cookies = await bankLoginPrompt('sber', fakeTiming()).withBrowser(async (session) => {
    await session.goto('https://web.alfabank.ru/login')
    await session.clearCookie('sid')
    return session.cookies('https://web.alfabank.ru/')
  })
  expect(cookies).toEqual([{ name: 'sid', value: 'v' }])
  expect(invoke).toHaveBeenCalledWith('bank_window_goto', { bank: 'sber', url: 'https://web.alfabank.ru/login' })
  expect(invoke).toHaveBeenCalledWith('bank_window_clear_cookie', { bank: 'sber', name: 'sid' })
  expect(invoke).toHaveBeenCalledWith('bank_window_cookies', { bank: 'sber', url: 'https://web.alfabank.ru/' })
})

test('ожидание адреса опрашивает окно до совпадения', async () => {
  const urls = ['about:blank', 'https://web.alfabank.ru/login', 'https://web.alfabank.ru/dashboard']
  invoke.mockImplementation(async (command: string) => (command === 'bank_window_url' ? urls.shift() : undefined))
  const timing = fakeTiming()
  await bankLoginPrompt('tbank', timing).withBrowser(async (session) => {
    await session.waitForUrl((url) => url.pathname.startsWith('/dashboard'), 10_000)
  })
  expect(urls).toEqual([])
  expect(timing.waits).toEqual([500, 500])
  expect(invoke).toHaveBeenCalledWith('bank_window_url', { bank: 'tbank' })
})

test('время вышло — вход не завершён, окно опрошено не раз', async () => {
  invoke.mockImplementation(async (command: string) => (command === 'bank_window_url' ? 'about:blank' : undefined))
  const timing = fakeTiming()
  await expect(
    bankLoginPrompt('alfa', timing).withBrowser((session) => session.waitForUrl(() => false, 1_000)),
  ).rejects.toThrow(/не завершён/)
  // проверки в 0, 500 и 1000 мс: на последней срок исчерпан
  const polls = commandsOf().filter((command) => command === 'bank_window_url')
  expect(polls).toHaveLength(3)
  expect(timing.waits).toEqual([500, 500])
})

test('окно закрыто человеком — ошибка команды прерывает ожидание, окно всё равно закрывается', async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'bank_window_url') throw new Error('окно закрыто')
    return undefined
  })
  await expect(
    bankLoginPrompt('alfa', fakeTiming()).withBrowser((session) => session.waitForUrl(() => false, 60_000)),
  ).rejects.toThrow('окно закрыто')
  expect(invoke).toHaveBeenLastCalledWith('bank_window_close', { bank: 'alfa' })
})

test('use упал и закрытие упало — наружу ошибка use, ошибка закрытия в журнале', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  invoke.mockImplementation(async (command: string) => {
    if (command === 'bank_window_close') throw new Error('закрыть не вышло')
    return undefined
  })
  await expect(
    bankLoginPrompt('alfa', fakeTiming()).withBrowser(async () => { throw new Error('сбой use') }),
  ).rejects.toThrow('сбой use')
  expect(log).toHaveBeenCalledWith(expect.stringContaining('закрыть не вышло'))
})

test('use успешен, закрытие упало — ошибка закрытия пробрасывается', async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'bank_window_close') throw new Error('закрыть не вышло')
    return undefined
  })
  await expect(bankLoginPrompt('alfa', fakeTiming()).withBrowser(async () => 1)).rejects.toThrow('закрыть не вышло')
})
