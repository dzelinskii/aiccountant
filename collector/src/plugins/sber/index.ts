import type { AllowlistClient } from '../../http/allowlist-client'
import { BankHttpError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials, LoginPrompt } from '../../core/contract'
import { createSberClient } from './client'
import { obtainSberCookies } from './login'
import { toAccounts, toOperations } from './map'

const OPERATIONS_PATH = '/uoh-bh/v1/operations/list'
const PRODUCTS_PATH = '/main-screen/rest/v2/m1/web/section/meta'

// Проверено разведкой: 250 проходит, 300 даёт 500. Берём подтверждённый предел
const PAGE_SIZE = 250
// Страховка от бесконечного обхода, если банк начнёт отдавать полные страницы
// бесконечно: 200 страниц — это 50 000 операций, заведомо больше любого периода
const MAX_PAGES = 200

interface PluginOptions {
  ca: string
  transport?: Transport
  timeoutMs?: number
}

export function createSberPlugin(options: PluginOptions): BankPlugin {
  const clientFor = (credentials: Credentials): AllowlistClient => createSberClient(credentials, options)

  return {
    name: 'sber',

    async login(prompt: LoginPrompt): Promise<Credentials> {
      return { kind: 'header', name: 'Cookie', value: await obtainSberCookies(prompt) }
    },

    async isAlive(credentials: Credentials): Promise<boolean> {
      try {
        await requestOperations(clientFor(credentials), { offset: 0, size: 1 })
        return true
      } catch (error) {
        // 403 — единственный ответ, означающий «предъявленных кук недостаточно».
        // Прочие статусы это не значат, и выдавать их за протухшую сессию нельзя:
        // получился бы круг «открыли окно входа → человек вошёл → та же ошибка»
        if (error instanceof BankHttpError && error.status === 403) return false
        throw error
      }
    },

    async fetchAccounts(credentials: Credentials): Promise<CollectedAccount[]> {
      const raw = await clientFor(credentials).postJson(PRODUCTS_PATH, { withData: true, forceUpdate: false })
      return toAccounts(cardsFrom(raw))
    },

    async fetchOperations(credentials: Credentials, accountId: string, since: number, until: number): Promise<CollectedOperation[]> {
      const client = clientFor(credentials)
      const collected: CollectedOperation[] = []

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const raw = await requestOperations(client, {
          offset: page * PAGE_SIZE,
          size: PAGE_SIZE,
          from: toSberDate(since),
          to: toSberDate(until),
          resource: accountId,
        })
        collected.push(...toOperations(raw, accountId))
        // короткая страница означает конец периода: банк отдал всё, что было
        if (raw.length < PAGE_SIZE) return collected
      }
      throw new Error(`Обход истории не сошёлся за ${MAX_PAGES} страниц — похоже, банк перестал уменьшать выдачу`)
    },
  }
}

interface OperationsQuery {
  offset: number
  size: number
  from?: string
  to?: string
  resource?: string
}

async function requestOperations(client: AllowlistClient, query: OperationsQuery): Promise<unknown[]> {
  const body: Record<string, unknown> = {
    paginationOffset: query.offset,
    paginationSize: query.size,
    showHidden: false,
    showNotTransactionBonuses: false,
    showOpenBanking: true,
  }
  if (query.from) body['from'] = query.from
  if (query.to) body['to'] = query.to
  if (query.resource) body['usedResource'] = [query.resource]

  const raw = await client.postJson(OPERATIONS_PATH, body)
  const operations = pick(raw, ['body', 'operations'])
  // молчаливая подмена не-массива на [] неотличима от «банк прислал 0 операций»
  if (!Array.isArray(operations)) throw new Error('Банк вернул историю не массивом')
  return operations
}

function cardsFrom(raw: unknown): unknown[] {
  const cards = pick(raw, ['body', 'sections', 'technicalSection', 'sectionProductData', 'cardsInWallet', 'data'])
  if (!Array.isArray(cards)) throw new Error('Банк вернул список карт не массивом')
  return cards
}

function pick(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

// Банк принимает только ДД.ММ.ГГГГTчч:мм:сс и по московскому времени; ISO и
// epoch дают 500. hourCycle: 'h23' обязателен: с hour12: false часть сборок ICU
// отдаёт "24" вместо "00" для полуночи, и банк такую строку отвергнет
const MOSCOW = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function toSberDate(millis: number): string {
  const parts = MOSCOW.formatToParts(new Date(millis))
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) throw new Error(`Не удалось получить часть даты "${type}"`)
    return part.value
  }
  return `${value('day')}.${value('month')}.${value('year')}T${value('hour')}:${value('minute')}:${value('second')}`
}
