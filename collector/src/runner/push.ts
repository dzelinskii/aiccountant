import type { FetchImpl } from '../http/allowlist-client'
import type { CollectedOperation } from '../plugins/tbank/types'
import type { CollectorConfig } from './config'

export interface PushResult {
  import_id: string
  status: string
}

// Сколько ошибок валидации показывать: бэкенд проверяет весь список операций
// разом, и на систематической проблеме их будет столько же, сколько операций
const MAX_REPORTED_DETAILS = 5

/**
 * Отправка собранных операций в наше приложение. Единственное место коллектора
 * вне src/http, которому разрешён глобальный fetch (исключение в .oxlintrc.json):
 * allowlist защищает токен банка от утечки на чужой хост, а здесь уходит токен
 * нашего приложения на наш же адрес из конфига — адрес, который не приходит из
 * ответов банка и потому не управляется извне.
 *
 * Возвращает null, если отправлять нечего: бэкенд пустой список не принимает.
 */
export async function pushOperations(
  config: CollectorConfig,
  accountId: string,
  operations: readonly CollectedOperation[],
  fetchImpl: FetchImpl = fetch,
): Promise<PushResult | null> {
  if (operations.length === 0) return null

  const url = new URL('/api/imports/parsed', config.apiBaseUrl)
  url.searchParams.set('workspace_id', config.workspaceId)
  url.searchParams.set('account_id', accountId)

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ parser: 'tbank_collector', operations }),
  })
  if (!res.ok) throw new Error(`Приложение ответило ${res.status}${await describeFailure(res)}`)
  return parseResult(await res.json())
}

function parseResult(data: unknown): PushResult {
  if (!isRecord(data) || typeof data['import_id'] !== 'string' || typeof data['status'] !== 'string') {
    throw new Error('Приложение вернуло неожиданный ответ на создание импорта')
  }
  return { import_id: data['import_id'], status: data['status'] }
}

/**
 * Пояснение бэкенда к отказу — без значений полей. На ошибке валидации FastAPI
 * отдаёт detail списком, и в каждом элементе лежит `input` с исходным значением:
 * подмешивание тела ответа целиком отправило бы в консоль суммы и описания
 * покупок. Берём только путь до поля и текст ошибки — сами по себе они значения
 * операции не содержат.
 */
async function describeFailure(res: Response): Promise<string> {
  const detail = await readDetail(res)
  if (typeof detail === 'string') return `: ${detail}`
  if (!Array.isArray(detail)) return ''
  const items = detail.slice(0, MAX_REPORTED_DETAILS).map(describeDetailItem)
  if (items.length === 0) return ''
  const more = detail.length > items.length ? ` (и ещё ${detail.length - items.length})` : ''
  return `: ${items.join('; ')}${more}`
}

async function readDetail(res: Response): Promise<unknown> {
  try {
    const body: unknown = await res.json()
    return isRecord(body) ? body['detail'] : undefined
  } catch {
    // не-JSON тело (например, страница ошибки прокси) в текст не тянем
    return undefined
  }
}

function describeDetailItem(item: unknown): string {
  if (!isRecord(item)) return 'ошибка валидации'
  const loc = Array.isArray(item['loc']) ? item['loc'].join('.') : ''
  const msg = typeof item['msg'] === 'string' ? item['msg'] : 'ошибка валидации'
  return loc ? `${loc}: ${msg}` : msg
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
