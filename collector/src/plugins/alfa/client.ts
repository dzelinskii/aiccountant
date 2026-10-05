import { BankClient } from '../../http/bank-client'
import type { Credentials } from '../../http/bank-client'
import type { Transport } from '../../http/transport'

export const ALFA_BASE = 'https://web.alfabank.ru'

// Пути ручек. Оболочка пускает только адреса из своего списка
// (desktop/src-tauri/src/banks.rs): новая ручка без строки там упрётся в отказ.
// GET /account/ обязателен со слэшем — без него банк отвечает 404 (разведка §5).
export const OPERATIONS_PATH = '/api/v1/operations-history/operations'
export const ACCOUNTS_PATH = '/api/v1/account/'
export const CARDS_PATH = '/api/v1/cards/masked-cards'
// Кредитные договоры клиента: кредиты в список счетов не входят (спека
// 2026-10-05-loan-balance-design.md §6a)
export const CREDITS_PATH = '/api/v1/credit/info'

interface CreateOptions {
  transport: Transport
  timeoutMs?: number
}

/**
 * Секрет Альфы — строка Cookie (минимальный набор: GW_SESSION_AO + XSRF-TOKEN).
 * На POST банк требует двойную отправку XSRF: значение куки XSRF-TOKEN обязано
 * повториться в заголовке X-XSRF-TOKEN. Извлекаем его из самой строки Cookie —
 * так второй копии секрета не заводим, и заголовок не разъедется с кукой.
 */
export function createAlfaClient(credentials: Credentials, { transport, timeoutMs }: CreateOptions): BankClient {
  if (credentials.kind !== 'header') {
    throw new Error('Альфа ожидает секрет заголовком Cookie — сохранённая запись не той формы')
  }
  const cookie = credentials.value
  return new BankClient({
    baseUrl: ALFA_BASE,
    credentials: { kind: 'headers', headers: { [credentials.name]: cookie, 'X-XSRF-TOKEN': xsrfFromCookie(cookie) } },
    transport,
    timeoutMs,
  })
}

function xsrfFromCookie(cookie: string): string {
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(cookie)
  const value = match?.[1]
  if (!value) throw new Error('В куке нет XSRF-TOKEN — POST к истории банк отверг бы (403)')
  return value
}
