export interface CollectorConfig {
  /** Адрес приложения: сегодня localhost, завтра — сервер. Меняется здесь и только здесь. */
  apiBaseUrl: string
  apiToken: string
  workspaceId: string
  /** Соответствие счетов банка нашим: заполняется один раз руками. */
  accountMap: Record<string, string>
  /** За сколько дней забирать операции при обычном запуске. */
  days: number
}

const DEFAULT_URL = 'http://localhost:8000'
const DEFAULT_DAYS = 30

/**
 * Здесь лежит токен нашего приложения — токен банка в конфиг не попадает
 * никогда, он живёт только в профиле браузера (см. session.ts).
 *
 * Любое непонятное значение — сразу ошибка с именем переменной: молчаливое
 * приведение типа даёт сбой не здесь, а на несколько шагов позже, где причина
 * уже не видна. Значение самого токена в сообщения не попадает.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  return {
    apiBaseUrl: parseUrl(env['AICCOUNTANT_URL']),
    apiToken: required(env, 'AICCOUNTANT_TOKEN'),
    workspaceId: required(env, 'AICCOUNTANT_WORKSPACE'),
    accountMap: parseAccountMap(env['AICCOUNTANT_ACCOUNTS']),
    days: parseDays(env['COLLECT_DAYS']),
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Не задана переменная ${name}`)
  return value
}

function parseUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`AICCOUNTANT_URL: ожидался адрес вида ${DEFAULT_URL}`)
  }
  // new URL('localhost:8000') разбирается успешно — как схема "localhost:"
  // с путём "8000", и запрос ушёл бы в никуда
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`AICCOUNTANT_URL: ожидался адрес вида ${DEFAULT_URL}`)
  }
  return raw
}

function parseAccountMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AICCOUNTANT_ACCOUNTS: ожидался JSON вида {"счёт банка":"счёт приложения"}')
  }
  // массив сюда проходит как объект с ключами "0", "1" — молча получилось бы
  // мусорное соответствие счетов вместо понятного отказа
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AICCOUNTANT_ACCOUNTS: ожидался JSON-объект, а не другое значение')
  }
  const map: Record<string, string> = {}
  for (const [bankAccount, appAccount] of Object.entries(parsed)) {
    if (bankAccount === '') {
      throw new Error('AICCOUNTANT_ACCOUNTS: пустой идентификатор счёта банка')
    }
    if (typeof appAccount !== 'string' || appAccount === '') {
      throw new Error(
        `AICCOUNTANT_ACCOUNTS: для счёта "${bankAccount}" ожидался идентификатор счёта приложения строкой`,
      )
    }
    map[bankAccount] = appAccount
  }
  return map
}

function parseDays(raw: string | undefined): number {
  if (!raw || raw.trim() === '') return DEFAULT_DAYS
  const days = Number(raw)
  // Number('abc') — это NaN, из которого получится невалидная дата и мусорный
  // запрос к банку; дробное и неположительное число дней тоже бессмысленны
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`COLLECT_DAYS: ожидалось положительное целое число дней, получено "${raw}"`)
  }
  return days
}
