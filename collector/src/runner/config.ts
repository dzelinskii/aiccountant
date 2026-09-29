import { BANK_NAMES } from '../plugins/registry'

export interface CollectorConfig {
  /** Адрес приложения: сегодня localhost, завтра — сервер. Меняется здесь и только здесь. */
  apiBaseUrl: string
  apiToken: string
  workspaceId: string
  /** За сколько дней забирать операции при обычном запуске. */
  days: number
  /** Какой банк собираем в этом запуске. */
  bank: string
}

const DEFAULT_URL = 'http://localhost:8000'
const DEFAULT_DAYS = 30
const DEFAULT_BANK = 'tbank'

/**
 * Здесь лежит токен нашего приложения — токен банка в конфиг не попадает
 * никогда, он живёт только в профиле браузера (см. session.ts).
 *
 * Любое непонятное значение — сразу ошибка с именем переменной: молчаливое
 * приведение типа даёт сбой не здесь, а на несколько шагов позже, где причина
 * уже не видна. Значение самого токена в сообщения не попадает.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const bank = parseBank(env['COLLECT_BANK'])
  return {
    apiBaseUrl: parseUrl(env['AICCOUNTANT_URL']),
    apiToken: required(env, 'AICCOUNTANT_TOKEN'),
    workspaceId: required(env, 'AICCOUNTANT_WORKSPACE'),
    days: parseDays(env['COLLECT_DAYS']),
    bank,
  }
}

function parseBank(raw: string | undefined): string {
  if (!raw || raw.trim() === '') return DEFAULT_BANK
  if (!BANK_NAMES.includes(raw)) {
    throw new Error(`COLLECT_BANK: неизвестный банк "${raw}". Известные: ${BANK_NAMES.join(', ')}`)
  }
  return raw
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
