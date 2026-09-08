import { fileURLToPath } from 'node:url'
import type { BankPlugin, CollectedAccount, Credentials } from '../core/contract'
import { pluginFor } from '../plugins/registry'
import { browserPrompt } from './browser'
import { loadConfig, type CollectorConfig } from './config'
import { pushOperations } from './push'
import { reportMissingHints, reportUnknownKinds } from './report'
import { osSecretStore, type SecretStore } from './secret-store'
import { ROOT_SPKI_SHA256, loadTrustAnchor } from './trust-anchor'

const DAY_MS = 86_400_000
const CA_CACHE = fileURLToPath(new URL('../../profile/russian_trusted_root_ca.pem', import.meta.url))

async function main(): Promise<void> {
  const config = loadConfig()
  // сертификат добывается лениво: банку, чей УЦ известен системе, он не нужен,
  // и падать из-за недоступности точки раздачи сертификата такой сбор не должен.
  // Побочно это же и определяет, надо ли закреплять ключ УЦ в окне входа: пин
  // получает ровно тот банк, который попросил корень, — без списка банков в
  // оболочке и без расширения доверия там, где оно не нужно
  let pinnedSpki: string | undefined
  const plugin = await pluginFor(config.bank, {
    loadCa: async () => {
      pinnedSpki = ROOT_SPKI_SHA256
      return loadTrustAnchor(CA_CACHE)
    },
  })
  const store = osSecretStore()

  const credentials = await connect(plugin, store, pinnedSpki)
  const accounts = await plugin.fetchAccounts(credentials)

  if (Object.keys(config.accountMap).length === 0) {
    printAccountsHint(accounts, config.bank)
    return
  }
  assertAccountsExist(config.accountMap, accounts)
  await collect(config, plugin, credentials, accounts)
  console.log('Готово. Подтвердите импорт в приложении.')
}

/**
 * Живость сессии проверяем до всякой работы. Мёртвый секрет остаётся в
 * хранилище, и без этой проверки каждый запуск доставал бы его заново, падал
 * посреди сбора и советовал «попробуйте ещё раз» — до бесконечности.
 */
async function connect(plugin: BankPlugin, store: SecretStore, pinnedSpki: string | undefined): Promise<Credentials> {
  const saved = await store.read(plugin.name)
  if (saved && (await plugin.isAlive(saved))) return saved

  // повторную попытку внутри входа делает сам плагин: только он знает, что у
  // его банка есть дешёвая фаза обновления и когда она бесполезна
  const fresh = await plugin.login(browserPrompt(plugin.name, { pinnedSpki }))
  if (!(await plugin.isAlive(fresh))) {
    throw new Error('Вход выполнен, но банк не признал полученную сессию')
  }
  await store.write(plugin.name, fresh)
  return fresh
}

async function collect(
  config: CollectorConfig,
  plugin: BankPlugin,
  credentials: Credentials,
  accounts: readonly CollectedAccount[],
): Promise<void> {
  const until = Date.now()
  const since = until - config.days * DAY_MS

  for (const [bankAccountId, appAccountId] of Object.entries(config.accountMap)) {
    const operations = await plugin.fetchOperations(credentials, bankAccountId, since, until)
    const account = accounts.find((item) => item.id === bankAccountId)
    const result = await pushOperations(config, plugin.name, appAccountId, operations, account)
    // в консоль только идентификаторы и счётчики: ни сумм, ни описаний
    console.log(
      result
        ? `счёт ${appAccountId}: собрано ${operations.length}, импорт ${result.import_id}`
        : `счёт ${appAccountId}: операций за период нет`,
    )
    // счётчики незнакомых видов и покупок без подсказки живут в общем report.ts:
    // они одинаковы для всех банков, и вторая копия разошлась бы с первой
    reportUnknownKinds(appAccountId, operations)
    reportMissingHints(appAccountId, operations)
  }
}

// Разовая подсказка человеку на его же машине: идентификаторы счетов банка
// взять больше неоткуда. Названия здесь уместны, остатки не печатаем
function printAccountsHint(accounts: readonly CollectedAccount[], bank: string): void {
  console.log('Счета в банке:')
  for (const account of accounts) {
    console.log(`  ${account.id}  ${account.currency ?? 'валюта не распознана'}  ${account.name}`)
  }
  console.log('')
  console.log(`Задайте AICCOUNTANT_ACCOUNTS_${bank.toUpperCase()} — соответствие счетов банка счетам приложения:`)
  const example = accounts[0]?.id ?? '<счёт банка>'
  console.log(`  AICCOUNTANT_ACCOUNTS_${bank.toUpperCase()}='{"${example}":"<uuid счёта в приложении>"}'`)
}

function assertAccountsExist(accountMap: Record<string, string>, accounts: readonly CollectedAccount[]): void {
  const known = new Set(accounts.map((account) => account.id))
  const unknown = Object.keys(accountMap).filter((id) => !known.has(id))
  if (unknown.length === 0) return
  throw new Error(
    `В списке счетов указаны те, которых у банка нет: ${unknown.join(', ')}. ` +
      'Список счетов банка печатается при пустом списке.',
  )
}

await main()
