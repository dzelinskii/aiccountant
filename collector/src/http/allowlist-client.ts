import { parseLossless } from './lossless-json'

export class NotAllowedError extends Error {}

interface Options {
  baseUrl: string
  allowedPaths: readonly string[]
  token: string
  fetchImpl?: typeof fetch
}

const REQUEST_TIMEOUT_MS = 30_000

/**
 * HTTP-клиент, который физически не способен на лишнее: только GET, только по
 * заранее перечисленным путям и без автоматического следования за редиректами.
 * Это не про доверие к коду, а про проверяемое ограничение — «что коллектор
 * может сделать» становится списком из пяти строк.
 */
export class AllowlistClient {
  private readonly baseUrl: string
  private readonly allowedPaths: readonly string[]
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor({ baseUrl, allowedPaths, token, fetchImpl = fetch }: Options) {
    this.baseUrl = baseUrl
    this.allowedPaths = allowedPaths
    this.token = token
    this.fetchImpl = fetchImpl
  }

  async getJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.allowedPaths.includes(path)) {
      // в сообщение кладём только путь: ни токена, ни параметров
      throw new NotAllowedError(`Путь не разрешён: ${path}`)
    }
    const url = new URL(path, this.baseUrl)
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new NotAllowedError('Чужой origin')
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    url.searchParams.set('sessionid', this.token)

    const res = await this.request(url)
    if (!res.ok) throw new Error(`Банк ответил ${res.status}`)
    const text = await res.text()
    try {
      return parseLossless(text)
    } catch {
      // тело ответа не пробрасываем: там операции и суммы, а не редкий повод
      // для отладки. Частый источник таких сбоев — протухшая сессия, банк в
      // этом случае вместо JSON отдаёт HTML-страницу логина
      throw new Error(`Банк вернул не JSON (${text.length} байт)`)
    }
  }

  // отдельная точка входа в сеть: fetchImpl — публичный параметр конструктора,
  // и инструментированная или сторонняя реализация может положить URL
  // (а в нём — токен в query) в текст собственной ошибки. Свою ошибку кладём
  // поверх, не пробрасывая исходную as is
  private async request(url: URL): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        // без этого fetch по умолчанию молча следует за Location, в том числе
        // на чужой origin — allowlist и проверка origin проверяются один раз,
        // до запроса, и редирект их обходит
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Error('Запрос к банку не удался')
    }
  }
}
