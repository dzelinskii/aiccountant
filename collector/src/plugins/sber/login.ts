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
    // Признак входа — переход по пути, начинающемуся с "/app/"; в форму входа
    // не вмешиваемся, код вводит человек. Это допущение, а не проверенный
    // факт: разведка не разбирала полный флоу авторизации до конца, и первый
    // же живой вход его либо подтвердит, либо нет. Если префикс окажется
    // другим, ждать здесь будем все LOGIN_TIMEOUT_MS и упадём по таймауту —
    // с сообщением про таймаут, а не про неверное допущение, так что при
    // разборе такого отказа стоит вспомнить и об этой возможности.
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
    const found = NEEDED.map((name) => cookies.find((cookie) => cookie.name === name && cookie.value !== ''))
    const complete = found.filter((cookie): cookie is { name: string; value: string } => cookie !== undefined)
    if (complete.length === NEEDED.length) {
      return complete.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }
    if (Date.now() > deadline) {
      const missing = NEEDED.filter((name) => !hasCookie(cookies, name))
      throw new Error(`Вход выполнен, но банк не оставил куки: ${missing.join(', ')} — сессии нет`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

// Пустое значение — не секрет: банк может завести куку раньше, чем наполнить
// её, и запись "UFS-SESSION=" пройдёт .find() как «кука есть». Уехав в
// хранилище такой строкой, она даст 403 на первом же запросе, isAlive
// вернёт false, и откроется то же самое окно входа — ровно круг, от которого
// защита и заводилась. Поэтому непустое значение проверяется и там, где кука
// считается найденной, и там, где составляется список недостающих.
function hasCookie(cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>, name: string): boolean {
  return cookies.some((cookie) => cookie.name === name && cookie.value !== '')
}
