export interface HttpResponse {
  readonly status: number
  readonly ok: boolean
  /**
   * Тело ответа. На не-2xx транспорт вправе отдать пустую строку — оболочка
   * так и делает: BankClient бросает BankHttpError по статусу раньше, чем
   * вызывает text().
   */
  text(): Promise<string>
}

export interface SendOptions {
  readonly method: 'GET' | 'POST'
  readonly headers: Record<string, string>
  readonly body?: string
  readonly signal: AbortSignal
}

/**
 * Узкий транспорт вместо голого fetch: банкам нужен корень УЦ Минцифры, а
 * доставку запроса обеспечивает оболочка — в окне приложения прямой fetch к
 * банку упёрся бы в CORS. Клиенту при этом всё равно, кто именно доставляет
 * запрос.
 */
export interface Transport {
  send(url: URL, options: SendOptions): Promise<HttpResponse>
}

/** Транспорт поверх fetch — для тестов ядра: в окне приложения к банку он не годится (см. Transport). */
export function fetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return {
    async send(url, { method, headers, body, signal }) {
      const res = await fetchImpl(url, {
        method,
        headers,
        body,
        // без этого fetch молча следует за Location, в том числе на чужой
        // origin, унося туда секрет. 'manual' (а не 'error') отдаёт редирект
        // наверх как обычный ответ со статусом 3xx — так же, как транспорт
        // оболочки, и клиент выше видит одну и ту же BankHttpError
        redirect: 'manual',
        signal,
      })
      return { status: res.status, ok: res.ok, text: () => res.text() }
    },
  }
}
