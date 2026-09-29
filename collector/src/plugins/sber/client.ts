import { BankClient } from '../../http/bank-client'
import type { Credentials } from '../../http/bank-client'
import type { Transport } from '../../http/transport'

export const SBER_BASE = 'https://web-node3.online.sberbank.ru'

// Пути ручек. Оболочка пускает только адреса из своего списка
// (desktop/src-tauri/src/banks.rs): новая ручка без строки там упрётся в отказ
export const OPERATIONS_PATH = '/uoh-bh/v1/operations/list'
export const PRODUCTS_PATH = '/main-screen/rest/v2/m1/web/section/meta'
// Детали карты. Нужен ровно ради долга по кредитке: в PRODUCTS_PATH его нет —
// там у карты только собственные средства и доступный лимит, а общего лимита,
// из которого долг можно было бы вывести, эта ручка не отдаёт (проверено:
// availableTotalLimit равен availableLimit). Зовётся только для карт типа credit
export const CARD_INFO_PATH = '/ufs-carddetail/rest/card/v1/cardInfo'

interface CreateOptions {
  transport: Transport
  timeoutMs?: number
}

export function createSberClient(credentials: Credentials, { transport, timeoutMs }: CreateOptions): BankClient {
  if (credentials.kind !== 'header') {
    throw new Error('Сбербанк ожидает секрет заголовком — сохранённая запись не той формы')
  }
  return new BankClient({
    baseUrl: SBER_BASE,
    credentials,
    transport,
    timeoutMs,
  })
}
