import type { CollectedAccount } from '../core/contract'
import type { AppAccount, NewAppAccount } from './app-accounts'
import { createAppAccount, fetchAppAccounts, linkAppAccount } from './app-accounts'
import type { CollectorConfig } from './config'
import { accountFingerprint } from './fingerprint'

// Тип своего счёта — словарь приложения, не банка. ACCOUNT_TYPES живёт на
// фронте, в другом рантайме, и делить его с коллектором нечем — держим
// короткую копию того же смысла здесь, а не общий файл ради трёх строк
const ACCOUNT_TYPE_CODES = ['card', 'cash', 'savings'] as const

export interface AskFns {
  ask(question: string): Promise<string>
  print(line: string): void
}

export type AskDecision =
  | { kind: 'ask'; candidates: readonly CollectedAccount[] }
  | { kind: 'skip'; unboundCount: number }

/**
 * Спрашивать ли вообще, и про какие счета.
 *
 * Решение владельца: пока не привязано ничего, спрашиваем про все
 * непривязанные счета, включая уже отклонённые раньше — запуск и так ничего
 * не соберёт, и молчать здесь значит оставить человека в тупике. Как только
 * привязано хоть что-то, спрашиваем только про счета, которых нет ни в
 * привязках, ни в отклонённых — про остальные человек уже высказался.
 *
 * `isTTY` проверяется здесь, а не в main.ts: main.ts — точка входа и
 * запускает сбор при импорте, тестом его не достать (см. report.ts), а без
 * терминала спрашивать не у кого — это и есть ответ на будущий сбор по
 * расписанию.
 */
export function decideCandidates(
  accounts: readonly CollectedAccount[],
  bank: string,
  linked: ReadonlyMap<string, string>,
  declined: ReadonlySet<string>,
  isTTY: boolean,
): AskDecision {
  const unbound = accounts.filter((account) => !linked.has(account.id))
  if (!isTTY || unbound.length === 0) return { kind: 'skip', unboundCount: unbound.length }

  const candidates =
    linked.size === 0
      ? unbound
      : unbound.filter((account) => !declined.has(accountFingerprint(bank, account.id)))

  return candidates.length === 0 ? { kind: 'skip', unboundCount: unbound.length } : { kind: 'ask', candidates }
}

/** Из счетов приложения — только те, что ещё не привязаны: привязанные уже отвечены. */
export function linkableAppAccounts(accounts: readonly AppAccount[]): readonly AppAccount[] {
  return accounts.filter((account) => !account.isBankLinked)
}

/**
 * Разбирает ответ на вопрос «какие счета вести»: номера через запятую,
 * 1-индексация — как в напечатанном списке. Пустая строка — «ни один». null —
 * ответ непонятен, и вызывающий обязан переспросить, а не считать это отказом
 * от всех счетов: опечатка не должна тихо превращаться в решение.
 */
export function parseSelection(input: string, count: number): number[] | null {
  const trimmed = input.trim()
  if (trimmed === '') return []

  const indices = new Set<number>()
  for (const part of trimmed.split(',').map((p) => p.trim())) {
    if (!/^[0-9]+$/.test(part)) return null
    const n = Number(part)
    if (n < 1 || n > count) return null
    indices.add(n - 1)
  }
  return [...indices].sort((a, b) => a - b)
}

export interface LinkPromptDeps {
  fetchAppAccounts: typeof fetchAppAccounts
  createAppAccount: typeof createAppAccount
  linkAppAccount: typeof linkAppAccount
}

const DEFAULT_DEPS: LinkPromptDeps = { fetchAppAccounts, createAppAccount, linkAppAccount }

export interface LinkPromptResult {
  /** Отпечатки счетов, про которые человек в этом разговоре сказал «не вести». */
  declined: string[]
}

/**
 * Разговор о том, какие из предложенных счетов вести. Логика отделена от
 * ввода-вывода: вызывающий передаёт готовый список и функции ask/print, а не
 * настоящий терминал — иначе разговор нечем было бы проверить тестом.
 */
export async function askAboutAccounts(
  config: CollectorConfig,
  bank: string,
  candidates: readonly CollectedAccount[],
  fns: AskFns,
  deps: LinkPromptDeps = DEFAULT_DEPS,
): Promise<LinkPromptResult> {
  fns.print('Счета в банке:')
  candidates.forEach((account, i) => fns.print(describeCandidate(i, account)))
  fns.print('')

  const chosen = await askSelection(candidates, fns)
  const declined = candidates
    .filter((_, i) => !chosen.includes(i))
    .map((account) => accountFingerprint(bank, account.id))

  if (chosen.length > 0) {
    const appAccounts = linkableAppAccounts(await deps.fetchAppAccounts(config))
    for (const i of chosen) {
      await resolveOneAccount(config, bank, candidates[i]!, appAccounts, fns, deps)
    }
  }

  return { declined }
}

// Остаток здесь — исключение из правила «в консоль только идентификаторы и
// счётчики»: это единственный способ узнать свой счёт в списке, и вывод виден
// только на машине владельца, а не в логах приложения.
function describeCandidate(index: number, account: CollectedAccount): string {
  const masks = account.cardMasks.length > 0 ? account.cardMasks.map((m) => `•• ${m}`).join(', ') : null
  const balance = account.balance ?? 'остаток не распознан'
  const parts = [account.name || '(без названия)', masks, balance].filter((part): part is string => part !== null)
  return `  ${index + 1}. ${parts.join(' — ')}`
}

async function askSelection(candidates: readonly CollectedAccount[], fns: AskFns): Promise<number[]> {
  fns.print('Какие вести? Номера через запятую, пустой ответ — ни один.')
  for (;;) {
    const answer = await fns.ask('> ')
    const parsed = parseSelection(answer, candidates.length)
    if (parsed !== null) return parsed
    fns.print(`Не разобрал ответ. Номера от 1 до ${candidates.length} через запятую, или пустая строка.`)
  }
}

async function resolveOneAccount(
  config: CollectorConfig,
  bank: string,
  account: CollectedAccount,
  appAccounts: readonly AppAccount[],
  fns: AskFns,
  deps: LinkPromptDeps,
): Promise<void> {
  const fingerprint = accountFingerprint(bank, account.id)
  const targetIndex = await askLinkTarget(account, appAccounts, fns)
  if (targetIndex !== null) {
    const target = appAccounts[targetIndex]!
    await deps.linkAppAccount(config, target.id, { bankCode: bank, fingerprint })
    fns.print(`Привязан к счёту ${target.id}.`)
    return
  }

  const type = await askAccountType(fns)
  const currency = account.currency ?? (await askCurrency(fns))
  const created = await deps.createAppAccount(config, {
    name: account.name.trim() !== '' ? account.name : `Счёт ${bank}`,
    type,
    currency,
    bankCode: bank,
    fingerprint,
  } satisfies NewAppAccount)
  fns.print(`Заведён счёт ${created.id}.`)
}

/** null — заводим новый счёт; иначе — индекс в appAccounts, к которому привязываем. */
async function askLinkTarget(
  account: CollectedAccount,
  appAccounts: readonly AppAccount[],
  fns: AskFns,
): Promise<number | null> {
  if (appAccounts.length === 0) return null

  fns.print(`${account.name || '(без названия)'}: привязать к существующему счёту или завести новый?`)
  fns.print('  0. Завести новый счёт')
  appAccounts.forEach((acc, i) => fns.print(`  ${i + 1}. ${acc.name}`))

  for (;;) {
    const answer = (await fns.ask('> ')).trim()
    if (/^[0-9]+$/.test(answer)) {
      const n = Number(answer)
      if (n === 0) return null
      if (n >= 1 && n <= appAccounts.length) return n - 1
    }
    fns.print(`Не разобрал ответ. Число от 0 до ${appAccounts.length}.`)
  }
}

async function askAccountType(fns: AskFns): Promise<string> {
  fns.print('Тип счёта:')
  ACCOUNT_TYPE_CODES.forEach((code, i) => fns.print(`  ${i + 1}. ${code}`))
  for (;;) {
    const answer = (await fns.ask('> ')).trim()
    const n = Number(answer)
    if (Number.isInteger(n) && n >= 1 && n <= ACCOUNT_TYPE_CODES.length) return ACCOUNT_TYPE_CODES[n - 1]!
    fns.print(`Не разобрал ответ. Число от 1 до ${ACCOUNT_TYPE_CODES.length}.`)
  }
}

async function askCurrency(fns: AskFns): Promise<string> {
  for (;;) {
    const answer = (await fns.ask('Валюта счёта не распознана. Код валюты (например, RUB): ')).trim().toUpperCase()
    if (/^[A-Z]{3}$/.test(answer)) return answer
    fns.print('Ожидался трёхбуквенный код валюты.')
  }
}
