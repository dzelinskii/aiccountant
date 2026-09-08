import { expect, test, vi } from 'vitest'
import type { BrowserSession, LoginPrompt } from '../../core/contract'
import { obtainTBankToken } from './login'

const SESSION_COOKIE = 'psid'

interface SessionScript {
  /** Кука, которую сессия видит с самого начала (имитация остывшего профиля). */
  initialCookie?: string
  /** Кука, которую банк выдаёт по завершении успешного waitForUrl (имитация того, что человек ввёл код). */
  cookieAfterLogin?: string
  /** waitForRequest не дожидается авторизованного запроса — таймаут, штатный путь «сессии нет». */
  waitForRequestFails?: boolean
  /** waitForUrl не дожидается перехода в ЛК. */
  waitForUrlFails?: boolean
  /** Позволяет тесту перехватить предикат, которым login.ts судит об авторизованности запроса. */
  onWaitForRequest?: (match: (url: URL) => boolean) => void
}

function makeSession(script: SessionScript = {}): BrowserSession {
  let cookie: string | null = script.initialCookie ?? null
  return {
    async goto() {},
    async clearCookie(name) {
      if (name === SESSION_COOKIE) cookie = null
    },
    async cookies() {
      return cookie === null ? [] : [{ name: SESSION_COOKIE, value: cookie }]
    },
    async waitForUrl() {
      if (script.waitForUrlFails) throw new Error('таймаут ожидания перехода в ЛК')
      if (script.cookieAfterLogin !== undefined) cookie = script.cookieAfterLogin
    },
    async waitForRequest(match) {
      script.onWaitForRequest?.(match)
      if (script.waitForRequestFails) throw new Error('таймаут ожидания авторизованного запроса')
    },
  }
}

function fakePrompt(sessions: {
  headless: BrowserSession
  visible: BrowserSession
}): { prompt: LoginPrompt; opened: Array<'headless' | 'visible'> } {
  const opened: Array<'headless' | 'visible'> = []
  const prompt: LoginPrompt = {
    async withBrowser(use, options) {
      const headless = options?.headless ?? false
      opened.push(headless ? 'headless' : 'visible')
      return use(headless ? sessions.headless : sessions.visible)
    },
  }
  return { prompt, opened }
}

// Видимая сессия, которую подсовываем там, где по сценарию она вовсе не
// должна открыться: любое обращение к ней — провал теста
function unusedSession(): BrowserSession {
  const fail = (): never => {
    throw new Error('видимое окно не должно было открыться')
  }
  return {
    goto: fail,
    clearCookie: fail,
    cookies: fail,
    waitForUrl: fail,
    waitForRequest: fail,
  }
}

test('обновление нашло живую куку и банк её признал — видимое окно не открывается вовсе', async () => {
  const headless = makeSession({ initialCookie: 'live-token' })
  const { prompt, opened } = fakePrompt({ headless, visible: unusedSession() })
  const isTokenAlive = vi.fn(async () => true)

  const token = await obtainTBankToken(prompt, isTokenAlive)

  expect(token).toBe('live-token')
  expect(opened).toEqual(['headless'])
  expect(isTokenAlive).toHaveBeenCalledWith('live-token')
})

test('обновление не дождалось авторизованного запроса — уходим в полный вход', async () => {
  const headless = makeSession({ waitForRequestFails: true })
  const visible = makeSession({ cookieAfterLogin: 'fresh-token' })
  const { prompt, opened } = fakePrompt({ headless, visible })
  const isTokenAlive = vi.fn(async () => true)

  const token = await obtainTBankToken(prompt, isTokenAlive)

  expect(token).toBe('fresh-token')
  expect(opened).toEqual(['headless', 'visible'])
  // токена не было — проверять на живость нечего
  expect(isTokenAlive).not.toHaveBeenCalled()
})

test('обновление вернуло куку, но банк её не признал — уходим в полный вход', async () => {
  // восстановленный случай: анонимная кука из остывшего профиля читается
  // без ошибок, но сессией банк её не считает
  const headless = makeSession({ initialCookie: 'dead-token' })
  const visible = makeSession({ cookieAfterLogin: 'fresh-token' })
  const { prompt, opened } = fakePrompt({ headless, visible })
  const isTokenAlive = vi.fn(async (token: string) => token !== 'dead-token')

  const token = await obtainTBankToken(prompt, isTokenAlive)

  expect(token).toBe('fresh-token')
  expect(opened).toEqual(['headless', 'visible'])
  expect(isTokenAlive).toHaveBeenCalledWith('dead-token')
})

test('вход прошёл, но банк не оставил куку — понятная ошибка', async () => {
  const headless = makeSession({ waitForRequestFails: true })
  const visible = makeSession() // waitForUrl проходит, но кука не появляется
  const { prompt } = fakePrompt({ headless, visible })

  await expect(obtainTBankToken(prompt, async () => true)).rejects.toThrow(/psid.*сессии нет/)
})

test('запрос к пути проверки сессии не считается доказательством авторизации, а запрос с sessionid — считается', async () => {
  let capturedMatch: ((url: URL) => boolean) | undefined
  const headless = makeSession({
    initialCookie: 'live-token',
    onWaitForRequest: (match) => {
      capturedMatch = match
    },
  })
  const { prompt } = fakePrompt({ headless, visible: unusedSession() })

  await obtainTBankToken(prompt, async () => true)

  expect(capturedMatch).toBeTypeOf('function')
  const probe = new URL('https://www.tbank.ru/api/common/v1/session_status?sessionid=anon-1')
  const authorizedRequest = new URL('https://www.tbank.ru/mybank/api/data?sessionid=real-1')
  const noSessionId = new URL('https://www.tbank.ru/mybank/api/data')
  // запрос проверки сессии несёт sessionid анонимной сессии — доказательством не считается
  expect(capturedMatch?.(probe)).toBe(false)
  expect(capturedMatch?.(authorizedRequest)).toBe(true)
  expect(capturedMatch?.(noSessionId)).toBe(false)
})
