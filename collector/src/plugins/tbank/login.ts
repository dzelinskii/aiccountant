import type { BrowserSession, LoginPrompt } from '../../core/contract'

const BANK_ORIGIN = 'https://www.tbank.ru'
const LOGIN_URL = `${BANK_ORIGIN}/login/`
const MYBANK_URL = `${BANK_ORIGIN}/mybank/`
const SESSION_COOKIE = 'psid'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const AUTHORIZED_REQUEST_TIMEOUT_MS = 60_000
// в фоновом обновлении таймаут короче: его истечение — обычный путь «сессии
// больше нет», за ним сразу открывается окно входа, и ждать тут нечего
const REFRESH_TIMEOUT_MS = 20_000

// session_status кабинет дёргает и когда сессии нет — это его способ спросить
// «я вообще залогинен?». Такой запрос несёт sessionid анонимной сессии, поэтому
// доказательством авторизации служить не может: считать его признаком успеха
// значит вернуть мёртвый токен ровно в том случае, ради которого проверка и
// заведена
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
 *
 * Обновление всегда идёт в headless-окне — это фоновый путь, и он не должен
 * дёргать окно браузера на каждый обычный запуск. Если фон не вернул токен
 * или банк его не признал (типичный случай — анонимная кука в остывшем
 * профиле, которую обновление вернуло бы как есть), нужен видимый вход:
 * другого способа получить код от человека нет. Проверка живости здесь —
 * забота плагина, а не оболочки: без неё мёртвый токен уехал бы наружу
 * как будто вход состоялся.
 */
export async function obtainTBankToken(
  prompt: LoginPrompt,
  isTokenAlive: (token: string) => Promise<boolean>,
): Promise<string> {
  const refreshed = await prompt.withBrowser(refresh, { headless: true })
  if (refreshed !== null && (await isTokenAlive(refreshed))) return refreshed
  // окно входа — только видимое: человек вводит телефон и код сам, коллектор
  // в форму не вмешивается
  return prompt.withBrowser(logIn, { headless: false })
}

async function refresh(session: BrowserSession): Promise<string | null> {
  await session.goto(MYBANK_URL)
  try {
    await session.waitForRequest(isAuthorized, REFRESH_TIMEOUT_MS)
  } catch {
    // Если сессии больше нет, ЛК уводит на страницу входа, и авторизованного
    // запроса просто не будет — таймаут здесь ожидаемый исход, а не поломка,
    // поэтому не бросаем, а честно возвращаем null: об этом судит вызывающая
    // сторона, открывая видимый вход. Ловим любую ошибку, а не только
    // таймаут: отличить их не усложняя контракт BrowserSession отдельным
    // типом ошибки нечем, а результат один и тот же — нужен видимый вход
    return null
  }
  return readToken(session)
}

async function logIn(session: BrowserSession): Promise<string> {
  // с протухшей кукой банк уводит со страницы входа обратно в ЛК, и мы бы
  // прочитали ровно тот же мёртвый токен
  await session.clearCookie(SESSION_COOKIE)
  await session.goto(LOGIN_URL)
  // ждём, пока человек сам введёт телефон и код: в форму входа не вмешиваемся
  await session.waitForUrl((url) => url.href.startsWith(MYBANK_URL), LOGIN_TIMEOUT_MS)
  // переход в ЛК ещё не означает рабочую сессию: кука уже есть, но банк её
  // сессией пока не считает и отвечает SESSION_IS_ABSENT. Дожидаемся
  // доказательства — собственного запроса ЛК за данными, который без живой
  // сессии не имеет смысла. Фиксированная пауза здесь была бы гаданием.
  await session.waitForRequest(isAuthorized, AUTHORIZED_REQUEST_TIMEOUT_MS)
  const token = await readToken(session)
  if (!token) throw new Error(`Вход выполнен, но банк не оставил куку ${SESSION_COOKIE} — сессии нет`)
  return token
}

async function readToken(session: BrowserSession): Promise<string | null> {
  const cookies = await session.cookies(BANK_ORIGIN)
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? null
}
