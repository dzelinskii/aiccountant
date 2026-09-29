import { parseLossless } from './lossless-json'
import type { Transport } from './transport'

export class NotAllowedError extends Error {}

/**
 * Банк ответил, но не успехом. Статус вынесен в поле, а не оставлен в тексте:
 * протухшую сессию (403) от сетевого сбоя приходится отличать в коде, и разбор
 * сообщения строкой был бы швом, который молча сломается при первой же правке
 * текста ошибки.
 */
export class BankHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Банк ответил ${status}`)
    this.status = status
  }
}

/**
 * Как предъявляется секрет банку. Для сбора это непрозрачное значение: он его
 * хранит и передаёт, но не толкует — у Т-Банка это токен в query, у Сбербанка
 * заголовок с куками, у Альфы — несколько заголовков сразу (кука плюс
 * производный от неё X-XSRF-TOKEN), и оболочка про разницу знать не должна.
 */
export type Credentials =
  | { readonly kind: 'query'; readonly name: string; readonly value: string }
  | { readonly kind: 'header'; readonly name: string; readonly value: string }
  | { readonly kind: 'headers'; readonly headers: Readonly<Record<string, string>> }

interface Options {
  baseUrl: string
  credentials: Credentials
  transport: Transport
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * HTTP-клиент банка: предъявляет секрет, разбирает ответ без потери разрядов и
 * не выпускает наружу ни секрета, ни тела ответа в тексте ошибок.
 *
 * Куда банку можно ходить, клиент не решает: список адресов и методов стоит у
 * транспорта, которому скрипт окна не указ (desktop/src-tauri/src/banks.rs).
 * Копия списка здесь разошлась бы с ним и продолжала бы выглядеть гарантией.
 * За редиректом клиент тоже не следит — транспорт возвращает 3xx обычным
 * ответом со статусом.
 */
export class BankClient {
  private readonly baseUrl: string
  private readonly credentials: Credentials
  private readonly transport: Transport
  private readonly timeoutMs: number

  constructor({ baseUrl, credentials, transport, timeoutMs = DEFAULT_TIMEOUT_MS }: Options) {
    this.baseUrl = baseUrl
    this.credentials = credentials
    this.transport = transport
    this.timeoutMs = timeoutMs
  }

  async getJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = this.buildUrl(path, params)
    return this.send(url, 'GET', undefined, path)
  }

  async postJson(path: string, body: unknown): Promise<unknown> {
    const url = this.buildUrl(path, {})
    return this.send(url, 'POST', JSON.stringify(body), path)
  }

  // секрет уходит с каждым запросом, поэтому путь, который при разрешении
  // уводит с базового origin (полный или протокольно-относительный адрес),
  // отвергается до сети
  private buildUrl(path: string, params: Record<string, string>): URL {
    const url = new URL(path, this.baseUrl)
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new NotAllowedError('Чужой origin')
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    if (this.credentials.kind === 'query') {
      url.searchParams.set(this.credentials.name, this.credentials.value)
    }
    return url
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.credentials.kind === 'header') {
      headers[this.credentials.name] = this.credentials.value
    } else if (this.credentials.kind === 'headers') {
      for (const [name, value] of Object.entries(this.credentials.headers)) headers[name] = value
    }
    return headers
  }

  private async send(url: URL, method: 'GET' | 'POST', body: string | undefined, path: string): Promise<unknown> {
    const headers = this.headers()
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const text = await this.fetchText(url, method, headers, body)
    try {
      return parseLossless(text)
    } catch {
      // тело ответа не пробрасываем: там операции и суммы. Частый источник
      // таких сбоев — протухшая сессия, банк тогда отдаёт HTML вместо JSON
      throw new Error(`Банк вернул не JSON на ${path} (${text.length} байт)`)
    }
  }

  // AbortController + setTimeout, снятый в finally, живут ровно до конца
  // запроса: таймер держит контроллер сильной ссылкой, в отличие от
  // AbortSignal.timeout(), чей таймер собирается GC до чтения тела
  private async fetchText(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body: string | undefined): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.transport.send(url, { method, headers, body, signal: controller.signal })
      if (!res.ok) throw new BankHttpError(res.status)
      return await res.text()
    } catch (e) {
      if (e instanceof BankHttpError) throw e
      // транспорт может положить URL (а в нём — секрет в query) в текст своей
      // ошибки, поэтому исходную ошибку как есть не пробрасываем
      throw new Error(`Не удалось получить ответ банка${describeCause(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

function describeCause(e: unknown): string {
  const name = hasStringProp(e, 'name') ? e.name : undefined
  const cause = hasProp(e, 'cause') ? e.cause : undefined
  // fetch (undici) кладёт код причины в e.cause.code, а транспорт оболочки и
  // ошибки node — прямо в e.code. Без проверки обоих мест таймаут, отказ в
  // соединении, недоверенный сертификат и обрыв тела выглядели бы одной и той
  // же строкой
  const code = (hasStringProp(cause, 'code') ? cause.code : undefined) ?? (hasStringProp(e, 'code') ? e.code : undefined)
  const parts = [name, code].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? ` (${parts.join(': ')})` : ''
}

function hasProp<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value
}

function hasStringProp<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return hasProp(value, key) && typeof value[key] === 'string'
}
