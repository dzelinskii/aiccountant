import { AllowlistClient } from '../../http/allowlist-client'
import type { AllowedEndpoint, Credentials } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import { httpsTransport } from '../../http/transport'

export const ALFA_BASE = 'https://web.alfabank.ru'

// Пути ручек — источник истины один: и allowlist, и вызывающий код (index.ts)
// собираются из этих констант. GET /account/ обязателен со слэшем — без него
// банк отвечает 404 (разведка §5).
export const OPERATIONS_PATH = '/api/v1/operations-history/operations'
export const ACCOUNTS_PATH = '/api/v1/account/'
export const CARDS_PATH = '/api/v1/cards/masked-cards'

// Три адреса — весь набор возможностей коллектора по Альфе.
//
// Та же оговорка, что у Сбера: история идёт по POST, поэтому «методом на чтение
// ничего не сломать» здесь не аргумент — гарантией остаётся сам список адресов,
// и все три читающие.
export const ALFA_ALLOWED: readonly AllowedEndpoint[] = [
  { path: OPERATIONS_PATH, method: 'POST' },
  { path: ACCOUNTS_PATH, method: 'GET' },
  { path: CARDS_PATH, method: 'GET' },
]

interface CreateOptions {
  ca: string
  transport?: Transport
  timeoutMs?: number
}

/**
 * Секрет Альфы — строка Cookie (минимальный набор: GW_SESSION_AO + XSRF-TOKEN).
 * На POST банк требует двойную отправку XSRF: значение куки XSRF-TOKEN обязано
 * повториться в заголовке X-XSRF-TOKEN. Извлекаем его из самой строки Cookie —
 * так второй копии секрета не заводим, и заголовок не разъедется с кукой.
 */
export function createAlfaClient(credentials: Credentials, { ca, transport, timeoutMs }: CreateOptions): AllowlistClient {
  if (credentials.kind !== 'header') {
    throw new Error('Альфа ожидает секрет заголовком Cookie — сохранённая запись не той формы')
  }
  const cookie = credentials.value
  return new AllowlistClient({
    baseUrl: ALFA_BASE,
    allowed: ALFA_ALLOWED,
    credentials: { kind: 'headers', headers: { [credentials.name]: cookie, 'X-XSRF-TOKEN': xsrfFromCookie(cookie) } },
    // корень УЦ Минцифры — тот же, что у Сбера; заменяет системный набор
    transport: transport ?? httpsTransport(ca),
    timeoutMs,
  })
}

function xsrfFromCookie(cookie: string): string {
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(cookie)
  const value = match?.[1]
  if (!value) throw new Error('В куке нет XSRF-TOKEN — POST к истории банк отверг бы (403)')
  return value
}
