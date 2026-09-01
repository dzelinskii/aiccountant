import { parseLossless } from './lossless-json'

export class NotAllowedError extends Error {}

interface Options {
  baseUrl: string
  allowedPaths: readonly string[]
  token: string
  fetchImpl?: typeof fetch
}

/**
 * HTTP-клиент, который физически не способен на лишнее: только GET и только по
 * заранее перечисленным путям. Это не про доверие к коду, а про проверяемое
 * ограничение — «что коллектор может сделать» становится списком из пяти строк.
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

    const res = await this.fetchImpl(url, { method: 'GET' })
    const text = await res.text()
    if (!res.ok) throw new Error(`Банк ответил ${res.status}`)
    return parseLossless(text)
  }
}
