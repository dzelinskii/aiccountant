import type { BankPlugin, CollectedAccount, Credentials, LoginPrompt } from '../core/contract'
import type { FetchImpl } from './app-api'
import { AppHttpError } from './app-api'
import type { AppConnection } from './app-connection'
import { syncDiscovered } from './discovered'
import { pushOperations } from './push'
import { countCollected, type CollectedCounters } from './report'

const DAY_MS = 86_400_000

/** Где живёт секрет сессии банка между сборами. */
export interface SessionStore {
  read(bank: string): Promise<Credentials | null>
  write(bank: string, credentials: Credentials): Promise<void>
}

/** Всё, что сбору нужно от места, где он работает: приложение или тест. */
export interface CollectHost {
  plugin: BankPlugin
  sessions: SessionStore
  prompt: LoginPrompt
  app: AppConnection
  /** За сколько дней забирать операции. */
  days: number
  now?: () => number
  fetchImpl?: FetchImpl
}

/** Откуда сессия: из хранилища или из только что пройденного входа. */
export type SessionSource = 'stored' | 'login'

export interface AccountResult {
  appAccountId: string
  /** Сколько операций доставлено в приложение: при отказе 0, хотя банк мог их отдать. */
  collected: number
  /** null — импорта нет: операций за период не было либо по счёту отказ (см. error). */
  importId: string | null
  counters: CollectedCounters
  /** Отказ по этому счёту; остальные счета собираются дальше. */
  error: string | null
}

export interface CollectSummary {
  bank: string
  session: SessionSource
  accounts: AccountResult[]
  /** Счета, которые банк показал, а в приложении они ни к чему не привязаны. */
  unboundCount: number
}

/**
 * Сессия банка умерла посреди сбора. Отличается от прочих отказов тем, что часть
 * счетов к этому моменту уже пройдена и по ним могли уйти импорты в приложение:
 * человеку нужно и войти заново, и знать, что сделанное не пропало.
 */
export class BankSessionExpiredError extends Error {
  /**
   * Итоги счетов, пройденных до смерти сессии; счёт, на котором она вскрылась,
   * сюда не входит. Импорт создан у тех, где importId не пуст.
   */
  readonly partial: AccountResult[]

  constructor(partial: AccountResult[]) {
    super('Сессия банка кончилась посреди сбора — войдите заново')
    this.partial = partial
  }
}

/**
 * Сбор одного банка: сессия, счета, сверка с приложением, операции по
 * привязанным счетам. Итог отдаётся объектом, а рисует его экран приложения.
 *
 * Бросает, когда продолжать бессмысленно для всех счетов разом: банк не признал
 * вход или недоступен, сессия банка умерла посреди сбора (`BankSessionExpiredError`),
 * приложение отвергло сессию. Отказ по одному счёту — не исключение, а строка итога.
 */
export async function collectBank(host: CollectHost): Promise<CollectSummary> {
  const { credentials, source } = await connect(host)
  const bankAccounts = await host.plugin.fetchAccounts(credentials)
  // какие счета вести, решает человек на экране «Счета»; сбор только сообщает,
  // что показал банк, и собирает привязанное
  const linked = await syncDiscovered(host.app, host.plugin.name, bankAccounts, host.fetchImpl)

  const until = (host.now ?? Date.now)()
  const since = until - host.days * DAY_MS
  const accounts: AccountResult[] = []
  let sessionChecked = false
  // на первой же ошибке счёта, не пришедшей от нашего приложения, выясняем, не
  // умерла ли сессия банка: иначе каждый следующий счёт получил бы тот же
  // отказ, а итог выглядел бы как невезение со счетами. Проверка одна — на
  // повторных ошибках она бы только нагружала банк
  const verifySession = async (): Promise<void> => {
    if (sessionChecked) return
    sessionChecked = true
    if (!(await host.plugin.isAlive(credentials))) {
      throw new BankSessionExpiredError([...accounts])
    }
  }
  for (const account of bankAccounts) {
    const appAccountId = linked.get(account.id)
    // счёт банка, который человек не завёл: не ошибка, а обычное дело —
    // из двенадцати счетов в приложении ведётся часть
    if (appAccountId === undefined) continue
    accounts.push(await collectAccount(host, credentials, account, appAccountId, since, until, verifySession))
  }
  const unboundCount = bankAccounts.filter((account) => !linked.has(account.id)).length
  return { bank: host.plugin.name, session: source, accounts, unboundCount }
}

/**
 * Живость сессии проверяем до всякой работы. Мёртвый секрет остаётся в
 * хранилище, и без этой проверки каждый сбор доставал бы его заново, падал
 * посреди работы и советовал «попробуйте ещё раз» — до бесконечности.
 */
async function connect(host: CollectHost): Promise<{ credentials: Credentials; source: SessionSource }> {
  const saved = await host.sessions.read(host.plugin.name)
  if (saved !== null && (await host.plugin.isAlive(saved))) return { credentials: saved, source: 'stored' }

  // повторную попытку внутри входа делает сам плагин: только он знает, что у
  // его банка есть дешёвая фаза обновления и когда она бесполезна
  const fresh = await host.plugin.login(host.prompt)
  if (!(await host.plugin.isAlive(fresh))) {
    throw new Error('Вход выполнен, но банк не признал полученную сессию')
  }
  await host.sessions.write(host.plugin.name, fresh)
  return { credentials: fresh, source: 'login' }
}

async function collectAccount(
  host: CollectHost,
  credentials: Credentials,
  account: CollectedAccount,
  appAccountId: string,
  since: number,
  until: number,
  verifySession: () => Promise<void>,
): Promise<AccountResult> {
  try {
    const operations = await host.plugin.fetchOperations(credentials, account.id, since, until)
    const pushed = await pushOperations(host.app, host.plugin.name, appAccountId, operations, account, host.fetchImpl)
    return {
      appAccountId,
      collected: operations.length,
      importId: pushed?.import_id ?? null,
      counters: countCollected(operations),
      error: null,
    }
  } catch (error) {
    // кончилась сессия приложения — дальше каждый счёт получит тот же отказ;
    // это не частичный успех, а повод показать вход
    if (error instanceof AppHttpError && error.status === 401) throw error
    // отказ нашего же приложения о банке ничего не говорит
    if (!(error instanceof AppHttpError)) await verifySession()
    return {
      appAccountId,
      collected: 0,
      importId: null,
      counters: countCollected([]),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
