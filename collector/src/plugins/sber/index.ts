import type { AllowlistClient } from '../../http/allowlist-client'
import { BankHttpError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials, LoginPrompt } from '../../core/contract'
import { CARD_INFO_PATH, createSberClient, OPERATIONS_PATH, PRODUCTS_PATH } from './client'
import { obtainSberCookies } from './login'
import { toAccounts, toOperations } from './map'

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
      const client = clientFor(credentials)
      const raw = await client.postJson(PRODUCTS_PATH, { withData: true, forceUpdate: false })
      const cards = cardsFrom(raw)
      return toAccounts(cards, await creditInfo(client, cards))
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

/**
 * Долг по кредитке лежит не там, где список карт, поэтому за ним идёт отдельный
 * запрос — и только для карт типа `credit`: дебетовым он не нужен, и лишнего
 * запроса за ними не отправляется.
 *
 * Спрашиваем по одной карте. Ответ cardInfo кладёт `creditType` внутрь блока
 * карты, и при запросе пачкой пришлось бы угадывать, к какой карте относится
 * найденный блок; кредиток у человека единицы, и экономия на запросах не стоит
 * такой догадки.
 *
 * Отказ этой ручки не роняет сбор: список счетов справочный, и терять из-за
 * него операции несоразмерно. Кредитка тогда приезжает без остатка (null, а не
 * ноль — см. map.ts), но молча это не проходит: в вывод идёт строка с
 * идентификатором карты.
 */
async function creditInfo(client: AllowlistClient, cards: readonly unknown[]): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>()
  for (const id of creditCardIds(cards)) {
    try {
      const block = findCreditType(await client.postJson(CARD_INFO_PATH, { cardIds: [id] }))
      if (block !== undefined) found.set(id, block)
    } catch {
      // ни сумм, ни тела ответа — только идентификатор карты
      console.log(`карта ${id}: долг по кредитке не получен, остаток показан не будет`)
    }
  }
  return found
}

function creditCardIds(cards: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const card of cards) {
    if (!isRecord(card)) continue
    if (String(card['type'] ?? '').toLowerCase() !== 'credit') continue
    const id = card['id']
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}

// Ищем блок creditType по всему ответу: точное место в конверте cardInfo не
// закреплено разведкой, а запрос идёт по одной карте — значит найденный блок
// относится именно к ней
function findCreditType(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCreditType(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (isRecord(value['creditType'])) return value['creditType']
  for (const nested of Object.values(value)) {
    const found = findCreditType(nested)
    if (found !== undefined) return found
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
