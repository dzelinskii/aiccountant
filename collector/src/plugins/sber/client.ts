import { AllowlistClient } from '../../http/allowlist-client'
import type { AllowedEndpoint, Credentials } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import { httpsTransport } from '../../http/transport'

export const SBER_BASE = 'https://web-node3.online.sberbank.ru'

// Пути ручек — источник истины один: и allowlist, и вызывающий код (index.ts)
// собираются из этих констант. Раньше пути были продублированы в двух файлах
// и могли разойтись молча — несовпадение всплыло бы только на живом запуске
// отказом allowlist
export const OPERATIONS_PATH = '/uoh-bh/v1/operations/list'
export const PRODUCTS_PATH = '/main-screen/rest/v2/m1/web/section/meta'

// Два адреса — весь набор возможностей коллектора по Сбербанку.
//
// Оговорка, которую важно не потерять: у Т-Банка список состоял из GET, и
// «методом на чтение ничего не сломать» было отдельной гарантией. Сбербанк
// отдаёт данные по POST, поэтому метод здесь ничего не доказывает — гарантией
// остаётся сам список адресов, и оба они читающие.
export const SBER_ALLOWED: readonly AllowedEndpoint[] = [
  { path: OPERATIONS_PATH, method: 'POST' },
  { path: PRODUCTS_PATH, method: 'POST' },
]

interface CreateOptions {
  ca: string
  transport?: Transport
  timeoutMs?: number
}

export function createSberClient(credentials: Credentials, { ca, transport, timeoutMs }: CreateOptions): AllowlistClient {
  if (credentials.kind !== 'header') {
    throw new Error('Сбербанк ожидает секрет заголовком — сохранённая запись не той формы')
  }
  return new AllowlistClient({
    baseUrl: SBER_BASE,
    allowed: SBER_ALLOWED,
    credentials,
    // корень УЦ Минцифры заменяет системный набор: у Сбербанка его в системе
    // нет, и одновременно это проверка строже системной — доверяем одному УЦ
    transport: transport ?? httpsTransport(ca),
    timeoutMs,
  })
}
