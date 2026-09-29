export type FetchImpl = typeof fetch
import type { AppConnection } from './app-connection'

// Сколько ошибок валидации показывать: бэкенд проверяет весь список операций
// разом, и на систематической проблеме их будет столько же, сколько операций
const MAX_REPORTED_DETAILS = 5

/**
 * Приложение ответило не успехом. Статус — полем, а не текстом: по нему решают,
 * например, что сессия приложения кончилась (всё остановить и показать вход),
 * а не что отказал один счёт.
 */
export class AppHttpError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(`Приложение ответило ${status}${detail}`)
    this.name = 'AppHttpError'
    this.status = status
  }
}

export interface AppRequest {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  /** Помимо workspace_id — его подставляет сам appRequest, в каждом запросе он один и тот же. */
  params?: Record<string, string>
  body?: unknown
}

/**
 * Единственное место коллектора вне src/http, откуда уходят запросы в наше
 * приложение (исключение в .oxlintrc.json): список адресов оболочки защищает
 * токен банка от утечки на чужой хост, а здесь уходит доступ к нашему
 * приложению на наш же адрес из соединения — адрес, который не приходит из
 * ответов банка и потому не управляется извне.
 *
 * На отказе бросает AppHttpError с кодом и разобранным пояснением бэкенда (без
 * значений полей — см. describeFailure), на успехе отдаёт разобранный JSON.
 */
export async function appRequest(
  connection: AppConnection,
  { method, path, params = {}, body }: AppRequest,
  fetchImpl: FetchImpl = fetch,
): Promise<unknown> {
  const url = new URL(path, connection.baseUrl)
  url.searchParams.set('workspace_id', connection.workspaceId)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const res = await fetchImpl(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: connection.authorization,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new AppHttpError(res.status, await describeFailure(res))
  return res.json()
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
