import type { BrowserSession, LoginPrompt } from '../../core/contract'

const LOGIN_URL = 'https://online.sberbank.ru'
const COOKIE_ORIGIN = 'https://web-node3.online.sberbank.ru'
const LOGIN_TIMEOUT_MS = 10 * 60_000
const COOKIE_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2_000

// Разведка показала: из 23 кук, уходящих на API, сессию держат ровно эти две.
// Остальные — WAF и аналитика, без них банк отвечает так же
const NEEDED = ['UFS-SESSION', 'UFS-TOKEN'] as const

/**
 * Обе куки httpOnly: скрипты страницы их не видят, но владелец cookie jar —
 * видит. Поэтому секрет забирается из браузера, а не со страницы.
 *
 * В отличие от Т-Банка, здесь нет тихого фонового обновления: куки
 * сессионные, профиль браузера их не сохраняет, и обновлять по остывшему
 * профилю нечего — окно входа всегда видимое, код вводит человек.
 */
export async function obtainSberCookies(prompt: LoginPrompt): Promise<string> {
  return prompt.withBrowser(async (session) => {
    await session.goto(LOGIN_URL)
    // признак входа — переход во внутренние разделы кабинета; в форму входа не
    // вмешиваемся, код вводит человек
    await session.waitForUrl((url) => url.pathname.startsWith('/app/'), LOGIN_TIMEOUT_MS)
    return collectCookies(session)
  })
}

/**
 * Куки появляются не одновременно с переходом в кабинет, поэтому ждём обе. Их
 * появление ещё не доказывает рабочую сессию — доказательство даёт первый же
 * запрос к API, который раннер делает сразу после входа.
 */
async function collectCookies(session: BrowserSession): Promise<string> {
  const deadline = Date.now() + COOKIE_TIMEOUT_MS
  for (;;) {
    const cookies = await session.cookies(COOKIE_ORIGIN)
    const found = NEEDED.map((name) => cookies.find((cookie) => cookie.name === name))
    const complete = found.filter((cookie): cookie is { name: string; value: string } => cookie !== undefined)
    if (complete.length === NEEDED.length) {
      return complete.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }
    if (Date.now() > deadline) {
      const missing = NEEDED.filter((name) => !cookies.some((cookie) => cookie.name === name))
      throw new Error(`Вход выполнен, но банк не оставил куки: ${missing.join(', ')} — сессии нет`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
