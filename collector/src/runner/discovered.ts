import type { CollectedAccount } from '../core/contract'
import type { FetchImpl } from '../http/allowlist-client'
import type { CollectorConfig } from './config'
import { accountFingerprint } from './fingerprint'

/**
 * Сообщить приложению, какие счета показал банк, и узнать, какие из них
 * привязаны к счетам приложения.
 *
 * Возвращает соответствие «идентификатор счёта банка → счёт приложения»:
 * отпечаток нужен только на проводе, а дальше по коду счета адресуются так,
 * как их называет банк — этим же значением работает fetchOperations.
 *
 * Тип счёта не отправляется: CollectedAccount.type — слово банка, и в ядро
 * приложения оно не едет.
 */
export async function syncDiscovered(
  config: CollectorConfig,
  bank: string,
  accounts: readonly CollectedAccount[],
  fetchImpl: FetchImpl = fetch,
): Promise<Map<string, string>> {
  const byFingerprint = new Map<string, string>()
  const payload = accounts.map((account) => {
    const fingerprint = accountFingerprint(bank, account.id)
    byFingerprint.set(fingerprint, account.id)
    return {
      fingerprint,
      name: account.name,
      currency: account.currency,
      balance: account.balance,
      card_masks: account.cardMasks,
    }
  })

  const url = new URL('/api/accounts/discovered', config.apiBaseUrl)
  url.searchParams.set('workspace_id', config.workspaceId)
  url.searchParams.set('bank', bank)

  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ accounts: payload }),
  })
  if (!res.ok) throw new Error(`Приложение ответило ${res.status} на список счетов`)

  const linked = new Map<string, string>()
  for (const [fingerprint, appAccountId] of Object.entries(parseLinked(await res.json()))) {
    const bankAccountId = byFingerprint.get(fingerprint)
    // отпечаток, которого мы не посылали, адресовать нечем — молча пропускаем
    // такую пару, а не гадаем, чей это счёт
    if (bankAccountId) linked.set(bankAccountId, appAccountId)
  }
  return linked
}

function parseLinked(data: unknown): Record<string, string> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Приложение вернуло неожиданный ответ на список счетов')
  }
  const linked = (data as Record<string, unknown>)['linked']
  if (typeof linked !== 'object' || linked === null || Array.isArray(linked)) {
    throw new Error('Приложение вернуло неожиданный ответ на список счетов')
  }
  const result: Record<string, string> = {}
  for (const [fingerprint, appAccountId] of Object.entries(linked)) {
    if (typeof appAccountId !== 'string') {
      throw new Error('Приложение вернуло неожиданный ответ на список счетов')
    }
    result[fingerprint] = appAccountId
  }
  return result
}
