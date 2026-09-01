import { parseLossless } from './lossless-json'

export class NotAllowedError extends Error {}

interface Options {
  baseUrl: string
  allowedPaths: readonly string[]
  token: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

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
  private readonly timeoutMs: number

  constructor({ baseUrl, allowedPaths, token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: Options) {
    this.baseUrl = baseUrl
    this.allowedPaths = allowedPaths
    this.token = token
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
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

    const text = await this.fetchText(url)
    try {
      return parseLossless(text)
    } catch {
      // тело ответа не пробрасываем: там операции и суммы, а не редкий повод
      // для отладки. Частый источник таких сбоев — протухшая сессия, банк в
      // этом случае вместо JSON отдаёт HTML-страницу логина
      throw new Error(`Банк вернул не JSON (${text.length} байт)`)
    }
  }

  // AbortSignal.timeout() держит свой таймер слабой ссылкой: сигнал, созданный
  // инлайн в отдельном вызове, после возврата Response становится недостижим и
  // собирается GC — к моменту чтения тела (res.text()) таймера уже нет. Фаза
  // заголовков отрабатывает только потому, что там сигнал держит сам undici, а
  // зависшее тело не оборвётся никогда. AbortController + setTimeout, снятый
  // в finally, живут ровно до конца запроса — таймер держит контроллер сильной
  // ссылкой
  private async fetchText(url: URL): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.request(url, controller.signal)
      if (!res.ok) throw new Error(`Банк ответил ${res.status}`)
      return await res.text()
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Банк ответил')) throw e
      // fetchImpl — публичный параметр конструктора, инструментированная
      // реализация может положить URL (а в нём — токен в query) в текст своей
      // ошибки, поэтому исходную ошибку не пробрасываем как есть. Но название
      // ошибки и код причины URL не содержат — заблокированный редирект,
      // обрыв DNS, таймаут и сетевой сбой стоит различать, а не схлопывать в
      // одно сообщение
      throw new Error(`Не удалось получить ответ банка${describeCause(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(url: URL, signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'GET',
      // без этого fetch по умолчанию молча следует за Location, в том числе
      // на чужой origin — allowlist и проверка origin проверяются один раз,
      // до запроса, и редирект их обходит
      redirect: 'error',
      signal,
    })
  }
}

function describeCause(e: unknown): string {
  const name = hasStringProp(e, 'name') ? e.name : undefined
  const cause = hasProp(e, 'cause') ? e.cause : undefined
  const code = hasStringProp(cause, 'code') ? cause.code : undefined
  const parts = [name, code].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? ` (${parts.join(': ')})` : ''
}

function hasProp<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value
}

function hasStringProp<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return hasProp(value, key) && typeof value[key] === 'string'
}
