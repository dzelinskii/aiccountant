import type { BankClient } from '../../http/bank-client'
import { BankHttpError } from '../../http/bank-client'
import type { Transport } from '../../http/transport'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials, LoginPrompt } from '../../core/contract'
import { ACCOUNTS_PATH, CARDS_PATH, CREDITS_PATH, OPERATIONS_PATH, createAlfaClient } from './client'
import { obtainAlfaCookies } from './login'
import { LOAN_ID_PREFIX, toAccounts, toLoanAccounts, toOperations } from './map'

// Разведка: size=100 проходит, 150 даёт 400. Берём подтверждённый предел
const PAGE_SIZE = 100
// Страховка от бесконечного обхода, если банк начнёт отдавать полные страницы
// без конца: 200 страниц — 20 000 операций, заведомо больше любого периода
const MAX_PAGES = 200

interface PluginOptions {
  transport: Transport
  timeoutMs?: number
}

export function createAlfaPlugin(options: PluginOptions): BankPlugin {
  const clientFor = (credentials: Credentials): BankClient => createAlfaClient(credentials, options)

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
      const loanAccounts = await loans(client)
      const accounts = toAccounts(arrayAt(accountsRaw, 'accounts', 'счета'), arrayAt(cardsRaw, 'cards', 'карты'))
      return [...accounts, ...loanAccounts]
    },

    async fetchOperations(credentials: Credentials, accountId: string, since: number, until: number): Promise<CollectedOperation[]> {
      // у счёта-кредита истории нет: платежи видны на текущем счёте, откуда
      // списываются, а ручка истории спрашивается по номеру счёта
      if (accountId.startsWith(LOAN_ID_PREFIX)) return []
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

// Договоры — дополнение к списку счетов: их отказ не должен отнимать у
// человека остальные счета и операции. Кредиты в этот сбор просто не приедут —
// и об этом остаётся след в консоли окна, а не тишина. В консоль идёт только
// имя ошибки: текст BankHttpError нёс бы путь, а суммы и адреса в логи не пишутся
async function loans(client: BankClient): Promise<CollectedAccount[]> {
  try {
    return toLoanAccounts(arrayAt(await client.getJson(CREDITS_PATH), 'contracts', 'кредитные договоры'))
  } catch (error) {
    console.warn('Альфа: кредитные договоры не получены', error instanceof Error ? error.name : typeof error)
    return []
  }
}

function arrayAt(raw: unknown, key: string, what: string): unknown[] {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined
  // молчаливая подмена не-массива на [] неотличима от «банк прислал 0 записей»
  if (!Array.isArray(value)) throw new Error(`Банк вернул ${what} не массивом`)
  return value
}
