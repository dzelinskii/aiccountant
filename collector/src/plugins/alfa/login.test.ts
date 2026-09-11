import { expect, test, vi } from 'vitest'
import type { BrowserSession, LoginPrompt } from '../../core/contract'
import { obtainAlfaCookies } from './login'

interface SessionScript {
  cookies?: Array<{ name: string; value: string }>
  waitForUrlFails?: boolean
}

function makeSession(script: SessionScript = {}): BrowserSession {
  return {
    async goto() {},
    async clearCookie() {},
    async cookies() {
      return script.cookies ?? []
    },
    async waitForUrl() {
      if (script.waitForUrlFails) throw new Error('таймаут ожидания перехода в кабинет')
    },
    async waitForRequest() {},
  }
}

function fakePrompt(session: BrowserSession): LoginPrompt {
  return {
    async withBrowser(use) {
      return use(session)
    },
  }
}

test('обе куки на месте — возвращается строка нужного вида', async () => {
  const session = makeSession({
    cookies: [
      { name: 'GW_SESSION_AO', value: 'sess-value' },
      { name: 'XSRF-TOKEN', value: 'xsrf-value' },
      { name: 'SUCAO', value: 'лишняя, не должна попасть в секрет' },
    ],
  })

  const result = await obtainAlfaCookies(fakePrompt(session))

  expect(result).toBe('GW_SESSION_AO=sess-value; XSRF-TOKEN=xsrf-value')
})

test('человек не вошёл за отведённое время — ошибка пробрасывается', async () => {
  const session = makeSession({ waitForUrlFails: true })
  await expect(obtainAlfaCookies(fakePrompt(session))).rejects.toThrow(/таймаут/i)
})

test('появилась только одна кука из двух — ошибка называет недостающую, без значений', async () => {
  vi.useFakeTimers()
  try {
    const session = makeSession({ cookies: [{ name: 'GW_SESSION_AO', value: 'super-secret-value' }] })
    const promise = obtainAlfaCookies(fakePrompt(session))
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(70_000)

    await expect(promise).rejects.toThrow(/XSRF-TOKEN/)
    await expect(promise).rejects.not.toThrow(/super-secret-value/)
  } finally {
    vi.useRealTimers()
  }
})

test('пустое значение сессионной куки не считается рабочим секретом', async () => {
  vi.useFakeTimers()
  try {
    const session = makeSession({
      cookies: [
        { name: 'GW_SESSION_AO', value: '' },
        { name: 'XSRF-TOKEN', value: 'xsrf-value' },
      ],
    })
    const promise = obtainAlfaCookies(fakePrompt(session))
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(70_000)

    await expect(promise).rejects.toThrow(/GW_SESSION_AO/)
  } finally {
    vi.useRealTimers()
  }
})
