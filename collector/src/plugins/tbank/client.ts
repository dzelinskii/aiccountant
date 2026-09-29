import { BankClient } from '../../http/bank-client'
import type { Transport } from '../../http/transport'

export const TBANK_BASE = 'https://www.tbank.ru'

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
