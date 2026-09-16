import type { FetchImpl } from '../http/allowlist-client'
import type { CollectorConfig } from './config'
import { appRequest } from './app-api'

/** Счёт приложения глазами разговора о привязке: только то, что для него нужно. */
export interface AppAccount {
  id: string
  name: string
  isBankLinked: boolean
}

/** Счета приложения — чтобы предложить привязку к уже заведённому счёту. */
export async function fetchAppAccounts(config: CollectorConfig, fetchImpl?: FetchImpl): Promise<AppAccount[]> {
  const data = await appRequest(config, { method: 'GET', path: '/api/accounts' }, fetchImpl)
  return parseAccounts(data)
}

export interface NewAppAccount {
  name: string
  type: string
  currency: string
  bankCode: string
  fingerprint: string
}

/** Заводит счёт приложения из счёта, который банк уже показал. */
export async function createAppAccount(
  config: CollectorConfig,
  account: NewAppAccount,
  fetchImpl?: FetchImpl,
): Promise<AppAccount> {
  const data = await appRequest(
    config,
    {
      method: 'POST',
      path: '/api/accounts',
      // имена полей — как в договоре API, а не как в NewAppAccount
      body: {
        name: account.name,
        type: account.type,
        currency: account.currency,
        bank_code: account.bankCode,
        bank_account_fingerprint: account.fingerprint,
      },
    },
    fetchImpl,
  )
  return parseAccount(data)
}

export interface LinkTarget {
  bankCode: string
  fingerprint: string
}

/** Привязывает уже заведённый счёт приложения к счёту банка. */
export async function linkAppAccount(
  config: CollectorConfig,
  accountId: string,
  target: LinkTarget,
  fetchImpl?: FetchImpl,
): Promise<AppAccount> {
  const data = await appRequest(
    config,
    {
      method: 'POST',
      path: `/api/accounts/${accountId}/link`,
      body: { bank_code: target.bankCode, bank_account_fingerprint: target.fingerprint },
    },
    fetchImpl,
  )
  return parseAccount(data)
}

function parseAccounts(data: unknown): AppAccount[] {
  if (!Array.isArray(data)) throw new Error('Приложение вернуло неожиданный ответ на список счетов')
  return data.map(parseAccount)
}

function parseAccount(data: unknown): AppAccount {
  if (
    !isRecord(data) ||
    typeof data['id'] !== 'string' ||
    typeof data['name'] !== 'string' ||
    typeof data['is_bank_linked'] !== 'boolean'
  ) {
    throw new Error('Приложение вернуло неожиданный ответ на счёт')
  }
  return { id: data['id'], name: data['name'], isBankLinked: data['is_bank_linked'] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
