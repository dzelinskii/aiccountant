import type { BrowserSession, LoginPrompt } from '../../core/contract'

const LOGIN_URL = 'https://web.alfabank.ru'
const COOKIE_ORIGIN = 'https://web.alfabank.ru'
const LOGIN_TIMEOUT_MS = 10 * 60_000
const COOKIE_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2_000

// Разведка показала: из 38 кук, уходящих на API, минимальный набор — эти две.
// GW_SESSION_AO (httpOnly) держит сессию, XSRF-TOKEN нужна для POST-истории
// (её значение уходит и в заголовок X-XSRF-TOKEN). Остальное — устройство,
// антифрод и аналитика — банку для этих ручек не требуется.
const NEEDED = ['GW_SESSION_AO', 'XSRF-TOKEN'] as const

/**
 * Вход через OpenID Connect: в форму не вмешиваемся, телефон/пароль/код или QR
 * вводит человек. GW_SESSION_AO — httpOnly: скрипты страницы её не видят, но
 * владелец cookie jar (Playwright) — да, поэтому секрет забирается из браузера.
 *
 * Тихого фонового обновления, как у Т-Банка, здесь нет: сессия короткая
 * (разведка — ~15–30 минут), профиль её не сохранит, и окно входа всегда
 * видимое. Настоящее продление — через refresh-токены OIDC, но это не v1
 * (см. спеку §4.3, §12).
 */
export async function obtainAlfaCookies(prompt: LoginPrompt): Promise<string> {
  return prompt.withBrowser(async (session) => {
    await session.goto(LOGIN_URL)
    // Признак входа — переход на путь, начинающийся с "/dashboard": после обмена
    // OIDC-кода пользователь оказывается там. Допущение подтверждено живым
    // входом в разведке. Если префикс окажется другим, ждать будем весь
    // LOGIN_TIMEOUT_MS и упадём по таймауту — при разборе такого отказа стоит
    // вспомнить и об этой возможности.
    await session.waitForUrl((url) => url.pathname.startsWith('/dashboard'), LOGIN_TIMEOUT_MS)
    return collectCookies(session)
  })
}

/**
 * Куки появляются не одновременно с переходом в кабинет, поэтому ждём обе. Их
 * появление ещё не доказывает рабочую сессию — доказательство даёт первый же
 * запрос к API, который раннер делает сразу после входа (isAlive).
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

// Пустое значение — не секрет: банк может завести куку раньше, чем наполнить её,
// и запись "GW_SESSION_AO=" прошла бы .find() как «кука есть». Уехав в
// хранилище такой строкой, она даст 302 на первом же запросе, isAlive вернёт
// false, и откроется то же окно входа — ровно круг, от которого защита и
// заводилась. Поэтому непустое значение проверяется в обоих местах.
function hasCookie(cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>, name: string): boolean {
  return cookies.some((cookie) => cookie.name === name && cookie.value !== '')
}
