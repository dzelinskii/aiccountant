import { AllowlistClient } from '../../http/allowlist-client'
import type { AllowedEndpoint } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'

export const TBANK_BASE = 'https://www.tbank.ru'

// Ровно пять адресов — весь набор возможностей коллектора виден списком
export const TBANK_ALLOWED: readonly AllowedEndpoint[] = [
  { path: '/api/common/v1/accounts_light_ib', method: 'GET' },
  { path: '/api/common/v1/session_status', method: 'GET' },
  { path: '/mybank/api/operations/timeline/public/legacy/v1/operations', method: 'GET' },
  { path: '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank', method: 'GET' },
  { path: '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user', method: 'GET' },
]

export const COMMON_PARAMS = {
  appName: 'supreme',
  appVersion: '0.0.1',
  origin: 'web,ib5,platform',
  platform: 'web',
} as const

interface CreateOptions {
  transport?: Transport
  timeoutMs?: number
}

export function createTBankClient(token: string, options: CreateOptions = {}): AllowlistClient {
  return new AllowlistClient({
    baseUrl: TBANK_BASE,
    allowed: TBANK_ALLOWED,
    credentials: { kind: 'query', name: 'sessionid', value: token },
    ...options,
  })
}
