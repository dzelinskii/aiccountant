import type { BrowserSession, LoginPrompt } from '../../core/contract'

const BANK_ORIGIN = 'https://www.tbank.ru'
const LOGIN_URL = `${BANK_ORIGIN}/login/`
const MYBANK_URL = `${BANK_ORIGIN}/mybank/`
const SESSION_COOKIE = 'psid'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const AUTHORIZED_REQUEST_TIMEOUT_MS = 60_000
const REFRESH_TIMEOUT_MS = 20_000

// session_status кабинет дёргает и когда сессии нет — доказательством
// авторизации служит запрос, несущий sessionid
const SESSION_PROBE_PATH = '/api/common/v1/session_status'

function isAuthorized(url: URL): boolean {
  if (url.pathname === SESSION_PROBE_PATH) return false
  const sessionid = url.searchParams.get('sessionid')
  return sessionid !== null && sessionid.length > 0
}

/**
 * psid короткоживущая и ротируется, поэтому в остывшем профиле почти всегда
 * лежит негодное значение. Долго живёт сама сессия: открываем ЛК, и банк по
 * живой сессии выдаёт свежую куку.
 */
export async function obtainTBankToken(prompt: LoginPrompt): Promise<string> {
  return prompt.withBrowser(async (session) => {
    const refreshed = await refresh(session)
    if (refreshed) return refreshed
    return logIn(session)
  })
}

async function refresh(session: BrowserSession): Promise<string | null> {
  await session.goto(MYBANK_URL)
  try {
    await session.waitForRequest(isAuthorized, REFRESH_TIMEOUT_MS)
  } catch {
    return null
  }
  return readToken(session)
}

async function logIn(session: BrowserSession): Promise<string> {
  // с протухшей кукой банк уводит со страницы входа обратно в ЛК, и мы бы
  // прочитали ровно тот же мёртвый токен
  await session.clearCookie(SESSION_COOKIE)
  await session.goto(LOGIN_URL)
  await session.waitForUrl((url) => url.href.startsWith(MYBANK_URL), LOGIN_TIMEOUT_MS)
  await session.waitForRequest(isAuthorized, AUTHORIZED_REQUEST_TIMEOUT_MS)
  const token = await readToken(session)
  if (!token) throw new Error(`Вход выполнен, но банк не оставил куку ${SESSION_COOKIE} — сессии нет`)
  return token
}

async function readToken(session: BrowserSession): Promise<string | null> {
  const cookies = await session.cookies(BANK_ORIGIN)
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? null
}
