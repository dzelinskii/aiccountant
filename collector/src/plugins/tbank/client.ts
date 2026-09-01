import { AllowlistClient, type FetchImpl } from '../../http/allowlist-client'

export const TBANK_BASE = 'https://www.tbank.ru'

// Ровно пять путей — весь набор возможностей коллектора виден списком, без
// доверия к тому, что код больше никуда не сходит
export const TBANK_ALLOWED = [
  '/api/common/v1/accounts_light_ib',
  '/api/common/v1/session_status',
  '/mybank/api/operations/timeline/public/legacy/v1/operations',
  '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank',
  '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user',
] as const

// Общие query-параметры, которые банк ожидает на всех эндпоинтах этого API
export const COMMON_PARAMS = {
  appName: 'supreme',
  appVersion: '0.0.1',
  origin: 'web,ib5,platform',
  platform: 'web',
} as const

interface CreateOptions {
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

export function createTBankClient(token: string, options: CreateOptions = {}): AllowlistClient {
  return new AllowlistClient({
    baseUrl: TBANK_BASE,
    allowedPaths: TBANK_ALLOWED,
    token,
    ...options,
  })
}
