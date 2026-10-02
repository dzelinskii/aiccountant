import { BankClient } from '../../http/bank-client'
import type { Transport } from '../../http/transport'

export const TBANK_BASE = 'https://www.tbank.ru'

// Пути ручек. Оболочка пускает только адреса из своего списка
// (desktop/src-tauri/src/banks.rs): новая ручка без строки там упрётся в отказ
export const SESSION_STATUS_PATH = '/api/common/v1/session_status'
export const ACCOUNTS_PATH = '/api/common/v1/accounts_light_ib'
export const OPERATIONS_PATH = '/mybank/api/operations/timeline/public/legacy/v1/operations'

export const COMMON_PARAMS = {
  appName: 'supreme',
  appVersion: '0.0.1',
  origin: 'web,ib5,platform',
  platform: 'web',
} as const

interface CreateOptions {
  transport: Transport
  timeoutMs?: number
}

export function createTBankClient(token: string, options: CreateOptions): BankClient {
  return new BankClient({
    baseUrl: TBANK_BASE,
    credentials: { kind: 'query', name: 'sessionid', value: token },
    ...options,
  })
}
