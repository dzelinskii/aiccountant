import type { CollectedAccount } from '../core/contract'
import type { FetchImpl } from '../http/allowlist-client'
import { appRequest } from './app-api'
import type { AppConnection } from './app-connection'
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
  connection: AppConnection,
  bank: string,
  accounts: readonly CollectedAccount[],
  // без значения по умолчанию: глобальный fetch остаётся только в app-api.ts,
  // а appRequest сам подставляет его, если сюда ничего не передали
  fetchImpl?: FetchImpl,
): Promise<Map<string, string>> {
  const fingerprints = await Promise.all(accounts.map((account) => accountFingerprint(bank, account.id)))
  const byFingerprint = new Map<string, string>()
  const payload = accounts.map((account, index) => {
    const fingerprint = fingerprints[index]!
    byFingerprint.set(fingerprint, account.id)
    return {
      fingerprint,
      name: account.name,
      currency: account.currency,
      balance: account.balance,
      card_masks: account.cardMasks,
    }
  })

  const data = await appRequest(
    connection,
    { method: 'PUT', path: '/api/accounts/discovered', params: { bank }, body: { accounts: payload } },
    fetchImpl,
  )

  const linked = new Map<string, string>()
  for (const [fingerprint, appAccountId] of Object.entries(parseLinked(data))) {
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
