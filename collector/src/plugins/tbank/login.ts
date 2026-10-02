import type { BrowserSession, LoginPrompt } from '../../core/contract'

const BANK_ORIGIN = 'https://www.tbank.ru'
const LOGIN_URL = `${BANK_ORIGIN}/login/`
const MYBANK_URL = `${BANK_ORIGIN}/mybank/`
const SESSION_COOKIE = 'psid'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS = 2_000
// после перехода в ЛК сессия оживает не сразу — кука уже есть, а банк отвечает
// SESSION_IS_ABSENT; минуты хватает с запасом
const LIVE_SESSION_TIMEOUT_MS = 60_000
// в фоновом обновлении таймаут короче: его истечение — обычный путь «сессии
// больше нет», за ним сразу открывается окно входа, и ждать тут нечего
const REFRESH_TIMEOUT_MS = 20_000

/** Часы входа. Подменяются в тестах, чтобы опрос шёл без реального ожидания. */
export interface LoginTiming {
  now(): number
  wait(ms: number): Promise<void>
}

const REAL_TIMING: LoginTiming = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * psid короткоживущая и ротируется, поэтому в остывшем профиле почти всегда
 * лежит негодное значение. Долго живёт сама сессия: открываем ЛК, и банк по
 * живой сессии выдаёт свежую куку.
 *
 * Сначала обновление по живому профилю в headless-окне — это фоновый путь, и
 * он не должен дёргать окно браузера на каждый обычный запуск. Видимое окно
 * открывается, только если фон не получил живой токен (типичный случай —
 * анонимная кука в остывшем профиле, которую обновление вернуло бы как есть):
 * другого способа получить код от человека нет. Живость проверяется на обоих
 * путях, поэтому мёртвый токен наружу не уезжает как будто вход состоялся.
 */
export async function obtainTBankToken(
  prompt: LoginPrompt,
  isTokenAlive: (token: string) => Promise<boolean>,
  timing: LoginTiming = REAL_TIMING,
): Promise<string> {
  const refreshed = await prompt.withBrowser(
    async (session) => {
      await session.goto(MYBANK_URL)
      return waitForLiveToken(session, isTokenAlive, timing, REFRESH_TIMEOUT_MS)
    },
    { headless: true },
  )
  if (refreshed !== null) return refreshed
  // окно входа — только видимое: другого способа получить код от человека нет
  return prompt.withBrowser(
    async (session) => {
      // с протухшей кукой банк уводит со страницы входа обратно в ЛК, и мы бы
      // прочитали ровно тот же мёртвый токен
      await session.clearCookie(SESSION_COOKIE)
      await session.goto(LOGIN_URL)
      // ждём, пока человек сам введёт телефон и код: в форму входа не вмешиваемся
      await session.waitForUrl((url) => url.href.startsWith(MYBANK_URL), LOGIN_TIMEOUT_MS)
      const token = await waitForLiveToken(session, isTokenAlive, timing, LIVE_SESSION_TIMEOUT_MS)
      if (token === null) throw new Error('Вход в Т-Банк выполнен, но сессия так и не ожила')
      return token
    },
    { headless: false },
  )
}

/**
 * Доказательство входа — живая сессия, а не переход в ЛК и не наличие куки:
 * psid есть и у анонимной сессии, которой кабинет пользуется, чтобы спросить
 * банк «я вообще залогинен?». Поэтому куку опрашиваем тем же вопросом, которым
 * проверяется сессия перед сбором. Недоступность банка (исключение из
 * isTokenAlive) не глотается: это не «сессии нет», и повторный вход её не лечит.
 * null — сессия за отведённое время не ожила.
 */
async function waitForLiveToken(
  session: BrowserSession,
  isTokenAlive: (token: string) => Promise<boolean>,
  timing: LoginTiming,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = timing.now() + timeoutMs
  for (;;) {
    const token = await readToken(session)
    if (token !== null && (await isTokenAlive(token))) return token
    if (timing.now() >= deadline) return null
    await timing.wait(POLL_INTERVAL_MS)
  }
}

async function readToken(session: BrowserSession): Promise<string | null> {
  const cookies = await session.cookies(BANK_ORIGIN)
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? null
}
