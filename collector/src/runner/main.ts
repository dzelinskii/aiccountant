import { fileURLToPath } from 'node:url'
import type { BankPlugin, CollectedAccount, Credentials } from '../core/contract'
import { pluginFor } from '../plugins/registry'
import { browserPrompt } from './browser'
import { loadConfig, type CollectorConfig } from './config'
import { syncDiscovered } from './discovered'
import { pushOperations } from './push'
import { reportCollected } from './report'
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
  // какие счета вести, решает человек в приложении: здесь мы только
  // рассказываем, что показал банк, и спрашиваем, куда слать импорты
  const linked = await syncDiscovered(config, plugin.name, accounts)

  if (linked.size === 0) {
    console.log('Ни один счёт банка не привязан к счёту приложения.')
    console.log('Заведите нужные счета на экране «Счета» и запустите сбор снова.')
    return
  }
  await collect(config, plugin, credentials, accounts, linked)
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
    const result = await pushOperations(config, plugin.name, appAccountId, operations, account)
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
