import type { AllowlistClient } from '../../http/allowlist-client'
import { BankHttpError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials, LoginPrompt } from '../../core/contract'
import { ACCOUNTS_PATH, CARDS_PATH, OPERATIONS_PATH, createAlfaClient } from './client'
import { obtainAlfaCookies } from './login'
import { toAccounts, toOperations } from './map'

// Разведка: size=100 проходит, 150 даёт 400. Берём подтверждённый предел
const PAGE_SIZE = 100
// Страховка от бесконечного обхода, если банк начнёт отдавать полные страницы
// без конца: 200 страниц — 20 000 операций, заведомо больше любого периода
const MAX_PAGES = 200

interface PluginOptions {
  ca: string
  transport?: Transport
  timeoutMs?: number
}

export function createAlfaPlugin(options: PluginOptions): BankPlugin {
  const clientFor = (credentials: Credentials): AllowlistClient => createAlfaClient(credentials, options)

  return {
    name: 'alfa',

    async login(prompt: LoginPrompt): Promise<Credentials> {
      return { kind: 'header', name: 'Cookie', value: await obtainAlfaCookies(prompt) }
    },

    async isAlive(credentials: Credentials): Promise<boolean> {
      try {
        await clientFor(credentials).getJson(ACCOUNTS_PATH)
        return true
      } catch (error) {
        // 302 (редирект на вход) — единственный ответ, означающий «сессия
        // истекла». Прочие статусы это не значат: выдать их за протухшую сессию
        // — тот же круг «окно входа → человек вошёл → та же ошибка», от которого
        // защита и заводилась. GET на эту ручку XSRF не требует, так что 403
        // тут не возникает.
        if (error instanceof BankHttpError && error.status === 302) return false
        throw error
      }
    },

    async fetchAccounts(credentials: Credentials): Promise<CollectedAccount[]> {
      const client = clientFor(credentials)
      const accountsRaw = await client.getJson(ACCOUNTS_PATH)
      const cardsRaw = await client.getJson(CARDS_PATH)
      return toAccounts(arrayAt(accountsRaw, 'accounts', 'счета'), arrayAt(cardsRaw, 'cards', 'карты'))
    },

    async fetchOperations(credentials: Credentials, accountId: string, since: number, until: number): Promise<CollectedOperation[]> {
      const client = clientFor(credentials)
      const collected: CollectedOperation[] = []

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const raw = await client.postJson(OPERATIONS_PATH, {
          size: PAGE_SIZE,
          page,
          forced: false,
          from: toAlfaDate(since),
          to: toAlfaDate(until),
          filters: [{ type: 'accounts', values: [accountId] }],
        })
        const operations = arrayAt(raw, 'operations', 'историю')
        collected.push(...toOperations(operations))
        // короткая страница означает конец периода: банк отдал всё, что было
        if (operations.length < PAGE_SIZE) return collected
      }
      throw new Error(`Обход истории не сошёлся за ${MAX_PAGES} страниц — банк перестал уменьшать выдачу`)
    },
  }
}

// Банк принимает даты как ГГГГ-ММ-ДД по московскому календарю (обе границы
// включительно). Через Intl, а не срезом epoch, — чтобы граница суток не
// уехала: en-CA даёт ровно YYYY-MM-DD
const MOSCOW = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function toAlfaDate(millis: number): string {
  return MOSCOW.format(new Date(millis))
}

function arrayAt(raw: unknown, key: string, what: string): unknown[] {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined
  // молчаливая подмена не-массива на [] неотличима от «банк прислал 0 записей»
  if (!Array.isArray(value)) throw new Error(`Банк вернул ${what} не массивом`)
  return value
}
