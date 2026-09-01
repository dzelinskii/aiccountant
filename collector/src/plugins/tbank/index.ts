import type { AllowlistClient } from '../../http/allowlist-client'
import { COMMON_PARAMS } from './client'
import { toAccounts, toOperations } from './map'
import type { CollectedAccount, CollectedOperation } from './types'

/** Токен протух: сессия Т-Банка истекла и нужен новый вход через браузер. */
export class SessionExpiredError extends Error {}

interface BankResponse {
  resultCode: string
  payload: unknown[]
}

export async function checkSession(client: AllowlistClient): Promise<void> {
  const response = await request(client, '/api/common/v1/session_status', {})
  assertOk(response)
}

export async function fetchAccounts(client: AllowlistClient): Promise<CollectedAccount[]> {
  const response = await request(client, '/api/common/v1/accounts_light_ib', {})
  assertOk(response)
  return toAccounts(response.payload)
}

export async function fetchOperations(
  client: AllowlistClient,
  accountId: string,
  since: number,
  until: number = Date.now(),
): Promise<CollectedOperation[]> {
  const response = await request(client, '/mybank/api/operations/timeline/public/legacy/v1/operations', {
    account: accountId,
    start: String(since),
    end: String(until),
  })
  assertOk(response)
  return toOperations(response.payload)
}

async function request(
  client: AllowlistClient,
  path: string,
  params: Record<string, string>,
): Promise<BankResponse> {
  const raw = await client.getJson(path, { ...COMMON_PARAMS, ...params })
  return asBankResponse(raw)
}

// resultCode приходит строкой и после parseLossless, но payload у него — не
// денежное значение, разбирать его строже смысла нет: достаточно проверить
// форму, дальше по вложенным записям пройдёт toOperations/toAccounts
function asBankResponse(data: unknown): BankResponse {
  if (!isRecord(data)) throw new Error('Банк вернул неожиданный формат ответа')
  const resultCode = data['resultCode']
  if (typeof resultCode !== 'string') throw new Error('Банк вернул неожиданный формат ответа')
  const payload = data['payload']
  return { resultCode, payload: Array.isArray(payload) ? payload : [] }
}

function assertOk(response: BankResponse): void {
  if (response.resultCode === 'OK') return
  if (response.resultCode === 'AUTHENTICATION_FAILED') {
    throw new SessionExpiredError('Сессия Т-Банка истекла, нужен повторный вход')
  }
  throw new Error(`Банк вернул ошибку: ${response.resultCode}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
