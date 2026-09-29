import { expect, test, vi } from 'vitest'
import type { BrowserSession, LoginPrompt } from '../../core/contract'
import { obtainTBankToken, type LoginTiming } from './login'

const COOKIE = 'psid'
const MYBANK_URL = 'https://www.tbank.ru/mybank/'
const LOGIN_URL = 'https://www.tbank.ru/login/'

// Часы подделки не дают опросу зависнуть: цикл, который не смотрит на срок или
// не ждёт, не возвращает управление в цикл событий, и без предохранителя
// дефект в опросе выглядел бы как зависший прогон, а не как упавший тест
function fakeTiming(): LoginTiming & { waits: number[] } {
  let clock = 0
  let reads = 0
  const waits: number[] = []
  return {
    waits,
    now: () => {
      if (++reads > 10_000) throw new Error('опрос не кончается')
      return clock
    },
    wait: async (ms) => {
      if (waits.length >= 10_000) throw new Error('опрос не кончается')
      waits.push(ms)
      clock += ms
    },
  }
}

interface FakeSession {
  session: BrowserSession
  /** Вызовы в порядке поступления; у goto и clearCookie — с аргументом. */
  calls: string[]
  /** Предикат, с которым плагин ждал перехода в ЛК. */
  urlMatch: () => ((url: URL) => boolean) | undefined
}

/**
 * Обе подделки делят одну куку: так видно, что видимый вход стёр мёртвую куку
 * до перехода на страницу входа, а не что она случайно оказалась другой.
 * onLogin имитирует то, что человек ввёл код.
 */
function fakeSession(cookie: { value: string | null }, onLogin?: () => void): FakeSession {
  const calls: string[] = []
  let urlMatch: ((url: URL) => boolean) | undefined
  const session: BrowserSession = {
    async goto(url) {
      calls.push(`goto:${url}`)
    },
    async clearCookie(name) {
      calls.push(`clearCookie:${name}`)
      if (name === COOKIE) cookie.value = null
    },
    async cookies() {
      calls.push('cookies')
      return cookie.value === null ? [] : [{ name: COOKIE, value: cookie.value }]
    },
    async waitForUrl(match) {
      calls.push('waitForUrl')
      urlMatch = match
      onLogin?.()
    },
  }
  return { session, calls, urlMatch: () => urlMatch }
}

function fakePrompt(
  headless: BrowserSession,
  visible: BrowserSession,
): { prompt: LoginPrompt; opened: Array<'headless' | 'visible'> } {
  const opened: Array<'headless' | 'visible'> = []
  const prompt: LoginPrompt = {
    async withBrowser(use, options) {
      const isHeadless = options?.headless ?? false
      opened.push(isHeadless ? 'headless' : 'visible')
      return use(isHeadless ? headless : visible)
    },
  }
  return { prompt, opened }
}

// Видимая сессия там, где по сценарию она вовсе не должна открыться:
// любое обращение к ней — провал теста
function unusedSession(): BrowserSession {
  const fail = (): never => {
    throw new Error('видимое окно не должно было открыться')
  }
  return { goto: fail, clearCookie: fail, cookies: fail, waitForUrl: fail }
}

const total = (values: number[]): number => values.reduce((sum, value) => sum + value, 0)

test('живая сессия в профиле — видимое окно не открывается, проверена именно прочитанная кука', async () => {
  const cookie = { value: 'live' }
  const headless = fakeSession(cookie)
  const { prompt, opened } = fakePrompt(headless.session, unusedSession())
  const isTokenAlive = vi.fn(async (token: string) => token === 'live')

  const token = await obtainTBankToken(prompt, isTokenAlive, fakeTiming())

  expect(token).toBe('live')
  expect(opened).toEqual(['headless'])
  expect(isTokenAlive).toHaveBeenCalledWith('live')
  expect(headless.calls[0]).toBe(`goto:${MYBANK_URL}`)
})

test('сессия оживает не сразу — ждём опросом раз в две секунды, а не фиксированной паузой', async () => {
  const cookie = { value: 'warming' }
  let checks = 0
  const timing = fakeTiming()
  const { prompt } = fakePrompt(fakeSession(cookie).session, unusedSession())

  const token = await obtainTBankToken(prompt, async () => ++checks >= 3, timing)

  expect(token).toBe('warming')
  expect(timing.waits).toEqual([2_000, 2_000])
})

test('фон не оживил сессию — видимый вход, мёртвая кука стёрта до перехода на вход', async () => {
  const cookie = { value: 'anonymous' }
  const visible = fakeSession(cookie, () => {
    cookie.value = 'fresh'
  })
  const { prompt, opened } = fakePrompt(fakeSession(cookie).session, visible.session)
  const timing = fakeTiming()

  const token = await obtainTBankToken(prompt, async (t) => t === 'fresh', timing)

  expect(token).toBe('fresh')
  expect(opened).toEqual(['headless', 'visible'])
  expect(visible.calls.slice(0, 3)).toEqual([`clearCookie:${COOKIE}`, `goto:${LOGIN_URL}`, 'waitForUrl'])
  // фон сдаётся за 20 секунд опроса, а не ждёт сессию бесконечно
  expect(total(timing.waits)).toBe(20_000)
})

test('человека ждут до перехода в ЛК: страница входа — ещё не вход, ЛК — уже вход', async () => {
  const cookie = { value: 'anonymous' }
  const visible = fakeSession(cookie, () => {
    cookie.value = 'fresh'
  })
  const { prompt } = fakePrompt(fakeSession(cookie).session, visible.session)

  await obtainTBankToken(prompt, async (t) => t === 'fresh', fakeTiming())

  expect(visible.urlMatch()?.(new URL(MYBANK_URL))).toBe(true)
  expect(visible.urlMatch()?.(new URL(LOGIN_URL))).toBe(false)
})

test('вход выполнен, но сессия так и не ожила — ошибка через минуту опроса, а не мёртвый токен', async () => {
  const cookie = { value: 'anonymous' }
  const timing = fakeTiming()
  const { prompt } = fakePrompt(fakeSession(cookie).session, fakeSession(cookie, () => {}).session)

  await expect(obtainTBankToken(prompt, async () => false, timing)).rejects.toThrow(/не ожила/)

  // 20 секунд фонового опроса и минута после видимого входа
  expect(total(timing.waits)).toBe(80_000)
})

test('вход выполнен, но куки нет вовсе — та же ошибка, живость пустого значения не проверяется', async () => {
  const cookie = { value: null as string | null }
  const isTokenAlive = vi.fn(async () => true)
  const { prompt } = fakePrompt(fakeSession(cookie).session, fakeSession(cookie).session)

  await expect(obtainTBankToken(prompt, isTokenAlive, fakeTiming())).rejects.toThrow(/не ожила/)

  expect(isTokenAlive).not.toHaveBeenCalled()
})

test('банк недоступен при фоновой проверке — ошибка сразу, видимое окно не открывается', async () => {
  const cookie = { value: 'live' }
  const { prompt, opened } = fakePrompt(fakeSession(cookie).session, unusedSession())
  const timing = fakeTiming()

  await expect(
    obtainTBankToken(
      prompt,
      async () => {
        throw new Error('Банк недоступен (таймаут)')
      },
      timing,
    ),
  ).rejects.toThrow(/недоступен/)

  expect(opened).toEqual(['headless'])
  // опрос не повторяется: недоступность банка — не «сессия ещё не ожила»
  expect(timing.waits).toEqual([])
})

test('банк недоступен после видимого входа — ошибка, а не «сессия не ожила»', async () => {
  const cookie = { value: 'anonymous' }
  const visible = fakeSession(cookie, () => {
    cookie.value = 'fresh'
  })
  const { prompt } = fakePrompt(fakeSession(cookie).session, visible.session)
  const isTokenAlive = async (token: string): Promise<boolean> => {
    if (token === 'fresh') throw new Error('Банк недоступен (5xx)')
    return false
  }

  await expect(obtainTBankToken(prompt, isTokenAlive, fakeTiming())).rejects.toThrow(/недоступен/)
})
