import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import type { BankPlugin, CollectedAccount, Credentials } from '../core/contract'
import { pluginFor } from '../plugins/registry'
import { browserPrompt } from './browser'
import { loadConfig, type CollectorConfig } from './config'
import { readDeclined, rememberDeclined } from './declined'
import { syncDiscovered } from './discovered'
import { httpsTransport } from './https-transport'
import { askAboutAccounts, decideCandidates } from './link-prompt'
import { pushOperations } from './push'
import { accountsWord, reportCollected } from './report'
import { osSecretStore, type SecretStore } from './secret-store'
import { ROOT_SPKI_SHA256, loadTrustAnchor } from './trust-anchor'

const DAY_MS = 86_400_000
const CA_CACHE = fileURLToPath(new URL('../../profile/russian_trusted_root_ca.pem', import.meta.url))

async function main(): Promise<void> {
  const config = loadConfig()
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
  // какие счета вести, решает человек: заранее в приложении или прямо здесь,
  // в разговоре ниже — коллектор только рассказывает, что показал банк
  let linked = await syncDiscovered(config, plugin.name, accounts)

  const declined = await readDeclined(plugin.name)
  // без терминала (будущий сбор по расписанию) спрашивать не у кого —
  // decideCandidates про это знает и в этом случае просто молчит
  const decision = decideCandidates(accounts, plugin.name, linked, declined, process.stdin.isTTY === true)

  if (decision.kind === 'ask') {
    const declinedNow = await conductLinkPrompt(config, plugin.name, decision.candidates)
    if (declinedNow.length > 0) await rememberDeclined(plugin.name, declinedNow)
    // разговор мог что-то привязать или завести — привязки собираем заново,
    // чтобы продолжить сбор в этом же запуске, без второго pnpm collect
    linked = await syncDiscovered(config, plugin.name, accounts)
  } else if (decision.unboundCount > 0) {
    console.log(`В банке ещё ${accountsWord(decision.unboundCount)} не ведётся.`)
  }

  if (linked.size === 0) {
    console.log('Ни один счёт банка не привязан к счёту приложения.')
    console.log('Заведите нужные счета на экране «Счета» и запустите сбор снова.')
    return
  }
  await collect(config, plugin, credentials, accounts, linked)
  console.log('Готово. Подтвердите импорт в приложении.')
}

/**
 * Своё окно терминала на разговор о счетах, закрывается сразу после него —
 * не закрыть его значило бы держать stdin открытым, и процесс не завершился
 * бы сам после сбора.
 */
async function conductLinkPrompt(
  config: CollectorConfig,
  bank: string,
  candidates: readonly CollectedAccount[],
): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const { declined } = await askAboutAccounts(config, bank, candidates, {
      ask: (question) => rl.question(question),
      print: (line) => console.log(line),
    })
    return declined
  } finally {
    rl.close()
  }
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
