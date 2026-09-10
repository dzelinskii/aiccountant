import { expect, test, vi } from 'vitest'
import type { BrowserSession, LoginPrompt } from '../../core/contract'
import { obtainSberCookies } from './login'

interface SessionScript {
  /** Куки, которые сессия отдаёт на каждый опрос — набор постоянный, без динамики во времени. */
  cookies?: Array<{ name: string; value: string }>
  /** waitForUrl не дожидается перехода в кабинет — эмуляция «человек не вошёл за отведённое время». */
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
      { name: 'UFS-SESSION', value: 'sess-value' },
      { name: 'UFS-TOKEN', value: 'token-value' },
    ],
  })

  const result = await obtainSberCookies(fakePrompt(session))

  expect(result).toBe('UFS-SESSION=sess-value; UFS-TOKEN=token-value')
})

test('человек не вошёл за отведённое время — ошибка пробрасывается', async () => {
  const session = makeSession({ waitForUrlFails: true })

  await expect(obtainSberCookies(fakePrompt(session))).rejects.toThrow(/таймаут/i)
})

test('появилась только одна кука из двух — ошибка называет только имена недостающих, без значений кук', async () => {
  vi.useFakeTimers()
  try {
    const session = makeSession({ cookies: [{ name: 'UFS-SESSION', value: 'super-secret-value' }] })

    const promise = obtainSberCookies(fakePrompt(session))
    // отказ приходит асинхронно внутри advanceTimersByTimeAsync, раньше, чем
    // до промиса дотянется первый expect — помечаем его обработанным сразу,
    // иначе тест-раннер увидит unhandled rejection
    promise.catch(() => {})
    // ждём дольше COOKIE_TIMEOUT_MS, чтобы цикл опроса дошёл до дедлайна
    await vi.advanceTimersByTimeAsync(70_000)

    await expect(promise).rejects.toThrow(/UFS-TOKEN/)
    await expect(promise).rejects.not.toThrow(/UFS-SESSION/)
    await expect(promise).rejects.not.toThrow(/super-secret-value/)
  } finally {
    vi.useRealTimers()
  }
})

test('пустое значение куки не считается рабочим секретом — тот же круг «окно входа», которого защита и не пускает', async () => {
  vi.useFakeTimers()
  try {
    const session = makeSession({
      cookies: [
        { name: 'UFS-SESSION', value: '' },
        { name: 'UFS-TOKEN', value: 'token-value' },
      ],
    })

    const promise = obtainSberCookies(fakePrompt(session))
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(70_000)

    await expect(promise).rejects.toThrow(/UFS-SESSION/)
  } finally {
    vi.useRealTimers()
  }
})
