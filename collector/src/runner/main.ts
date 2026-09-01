import type { AllowlistClient } from '../http/allowlist-client'
import { createTBankClient } from '../plugins/tbank/client'
import { SessionExpiredError, checkSession, fetchAccounts, fetchOperations } from '../plugins/tbank/index'
import type { CollectedAccount } from '../plugins/tbank/types'
import { loadConfig, type CollectorConfig } from './config'
import { pushOperations } from './push'
import { obtainSessionToken } from './session'

const DAY_MS = 86_400_000

async function main(): Promise<void> {
  const config = loadConfig()
  const client = await connectToBank()
  const accounts = await fetchAccounts(client)

  if (Object.keys(config.accountMap).length === 0) {
    printAccountsHint(accounts)
    return
  }
  assertAccountsExist(config.accountMap, accounts)
  await collect(config, client)
  console.log('Готово. Подтвердите импорт в приложении.')
}

/**
 * Живость сессии проверяем до всякой работы. Протухшая кука остаётся лежать в
 * профиле, и без этой проверки каждый запуск доставал бы её заново, падал уже
 * посреди сбора и советовал «запустите ещё раз» — до бесконечности, пока
 * человек не удалит профиль руками.
 */
async function connectToBank(): Promise<AllowlistClient> {
  const client = createTBankClient(await obtainSessionToken())
  try {
    await checkSession(client)
    return client
  } catch (error) {
    if (!(error instanceof SessionExpiredError)) throw error
  }
  const renewed = createTBankClient(await obtainSessionToken({ forceLogin: true }))
  await checkSession(renewed)
  return renewed
}

async function collect(config: CollectorConfig, client: AllowlistClient): Promise<void> {
  const since = Date.now() - config.days * DAY_MS
  for (const [bankAccountId, appAccountId] of Object.entries(config.accountMap)) {
    const operations = await fetchOperations(client, bankAccountId, since)
    const result = await pushOperations(config, appAccountId, operations)
    // в консоль только идентификаторы и счётчики: ни сумм, ни описаний
    console.log(
      result
        ? `счёт ${appAccountId}: собрано ${operations.length}, импорт ${result.import_id}`
        : `счёт ${appAccountId}: операций за период нет`,
    )
  }
}

// Разовая подсказка человеку на его же машине: идентификаторы счетов банка
// взять больше неоткуда, без них коллектор не настроить. Названия здесь
// уместны — без них список неотличимых строк бесполезен; остатки не печатаем
function printAccountsHint(accounts: CollectedAccount[]): void {
  console.log('Счета в банке:')
  for (const account of accounts) {
    console.log(`  ${account.id}  ${account.currency}  ${account.name}`)
  }
  console.log('')
  console.log('Задайте AICCOUNTANT_ACCOUNTS — соответствие счетов банка счетам приложения:')
  const example = accounts[0]?.id ?? '<счёт банка>'
  console.log(`  AICCOUNTANT_ACCOUNTS='{"${example}":"<uuid счёта в приложении>"}'`)
}

function assertAccountsExist(accountMap: Record<string, string>, accounts: CollectedAccount[]): void {
  const known = new Set(accounts.map((account) => account.id))
  const unknown = Object.keys(accountMap).filter((id) => !known.has(id))
  if (unknown.length === 0) return
  throw new Error(
    `В AICCOUNTANT_ACCOUNTS указаны счета, которых у банка нет: ${unknown.join(', ')}. ` +
      'Список счетов банка печатается при пустом AICCOUNTANT_ACCOUNTS.',
  )
}

await main().catch((error: unknown) => {
  if (error instanceof SessionExpiredError) {
    console.error('Сессия банка истекла — запустите команду ещё раз и войдите в открывшемся окне')
    process.exitCode = 1
    return
  }
  throw error
})
