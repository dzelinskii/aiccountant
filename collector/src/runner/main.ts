import { fileURLToPath } from 'node:url'
import type { AppConnection } from '../collect/app-connection'
import { syncDiscovered } from '../collect/discovered'
import { pushOperations } from '../collect/push'
import { accountsWord, reportCollected } from '../collect/report'
import type { BankPlugin, CollectedAccount, Credentials } from '../core/contract'
import { pluginFor } from '../plugins/registry'
import { browserPrompt } from './browser'
import { appConnection, loadConfig, type CollectorConfig } from './config'
import { httpsTransport } from './https-transport'
import { osSecretStore, type SecretStore } from './secret-store'
import { ROOT_SPKI_SHA256, loadTrustAnchor } from './trust-anchor'

const DAY_MS = 86_400_000
const CA_CACHE = fileURLToPath(new URL('../../profile/russian_trusted_root_ca.pem', import.meta.url))

async function main(): Promise<void> {
  const config = loadConfig()
  const connection = appConnection(config)
  // Т-Банк 2026-09-29 отдал цепочку от корня Минцифры, поэтому до своего
  // удаления CLI ходит во все три банка через один транспорт с этим корнем и
  // закрепляет его ключ в окне входа у всех трёх. Спека десктопного клиента
  // (§3.1) оставляет Т-Банку и системный набор корней, а этот транспорт его
  // заменяет — CLI позволяет себе такое упрощение, пока он жив
  const transport = httpsTransport(await loadTrustAnchor(CA_CACHE))
  const plugin = await pluginFor(config.bank, { transport: async () => transport })
  const pinnedSpki = ROOT_SPKI_SHA256
  const store = osSecretStore()

  const credentials = await connect(plugin, store, pinnedSpki)
  const accounts = await plugin.fetchAccounts(credentials)
  // какие счета вести, решает человек на экране «Счета» приложения —
  // коллектор только рассказывает, что показал банк
  const linked = await syncDiscovered(connection, plugin.name, accounts)
  const unbound = accounts.filter((account) => !linked.has(account.id)).length
  if (unbound > 0) console.log(`В банке ещё ${accountsWord(unbound)} не ведётся. Привяжите их на экране «Счета».`)

  if (linked.size === 0) {
    console.log('Ни один счёт банка не привязан к счёту приложения.')
    console.log('Заведите нужные счета на экране «Счета» и запустите сбор снова.')
    return
  }
  await collect(config, connection, plugin, credentials, accounts, linked)
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
  connection: AppConnection,
  plugin: BankPlugin,
  credentials: Credentials,
  accounts: readonly CollectedAccount[],
  linked: ReadonlyMap<string, string>,
): Promise<void> {
  const until = Date.now()
  const since = until - config.days * DAY_MS

  for (const account of accounts) {
    const appAccountId = linked.get(account.id)
    // счёт банка, который человек не завёл: не ошибка, а обычное дело —
    // из двенадцати счетов в приложении ведётся часть
    if (!appAccountId) continue
    const operations = await plugin.fetchOperations(credentials, account.id, since, until)
    const result = await pushOperations(connection, plugin.name, appAccountId, operations, account)
    // в консоль только идентификаторы и счётчики: ни сумм, ни описаний
    console.log(
      result
        ? `счёт ${appAccountId}: собрано ${operations.length}, импорт ${result.import_id}`
        : `счёт ${appAccountId}: операций за период нет`,
    )
    // счётчики живут в общем report.ts: они одинаковы для всех банков, и
    // вторая копия разошлась бы с первой
    reportCollected(appAccountId, operations)
  }
}

await main()
