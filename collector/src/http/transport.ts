import { request as httpsRequest } from 'node:https'

export interface HttpResponse {
  readonly status: number
  readonly ok: boolean
  text(): Promise<string>
}

export interface SendOptions {
  readonly method: 'GET' | 'POST'
  readonly headers: Record<string, string>
  readonly body?: string
  readonly signal: AbortSignal
}

/**
 * Узкий транспорт вместо голого fetch: Сбербанку нужен свой корневой
 * сертификат, а fetch в Node принять его не умеет — только node:https. Клиенту
 * при этом всё равно, кто именно доставляет запрос.
 */
export interface Transport {
  send(url: URL, options: SendOptions): Promise<HttpResponse>
}

export function fetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return {
    async send(url, { method, headers, body, signal }) {
      const res = await fetchImpl(url, {
        method,
        headers,
        body,
        // без этого fetch молча следует за Location, в том числе на чужой
        // origin — allowlist проверяется один раз, до запроса, и редирект его
        // обходит
        redirect: 'error',
        signal,
      })
      return { status: res.status, ok: res.ok, text: () => res.text() }
    },
  }
}

/**
 * Транспорт с явным якорем доверия: переданный корень ЗАМЕНЯЕТ системный набор,
 * а не дополняет его. Для банка, чей УЦ в системе отсутствует, это одновременно
 * и единственный способ соединиться, и проверка строже системной.
 */
export function httpsTransport(ca: string): Transport {
  return {
    send(url, { method, headers, body, signal }) {
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          url,
          {
            method,
            ca,
            headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
          },
          (res) => {
            const status = res.statusCode ?? 0
            let text = ''
            res.setEncoding('utf-8')
            res.on('data', (chunk: string) => {
              text += chunk
            })
            res.on('end', () => {
              resolve({ status, ok: status >= 200 && status < 300, text: async () => text })
            })
          },
        )
        // редирект node:https сам не проходит, но и ошибкой не считает —
        // проверяем статус на стороне клиента (см. allowlist-client)
        req.on('error', reject)
        signal.addEventListener('abort', () => req.destroy(new Error('Таймаут запроса')), { once: true })
        if (body !== undefined) req.write(body)
        req.end()
      })
    },
  }
}
