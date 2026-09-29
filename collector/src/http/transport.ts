export interface HttpResponse {
  readonly status: number
  readonly ok: boolean
  /**
   * Тело ответа. На 2xx оба транспорта отдают настоящий текст. На не-2xx
   * поведение расходится: fetchTransport по-прежнему отдаёт тело, а
   * httpsTransport — всегда пустую строку (поток сливается, а не копится,
   * см. httpsTransport). Сегодня разница безвредна: AllowlistClient бросает
   * BankHttpError по статусу раньше, чем вызывает text().
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

export function fetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return {
    async send(url, { method, headers, body, signal }) {
      const res = await fetchImpl(url, {
        method,
        headers,
        body,
        // без этого fetch молча следует за Location, в том числе на чужой
        // origin — allowlist проверяется один раз, до запроса, и редирект его
        // обходит. 'manual' (а не 'error') отдаёт редирект наверх как обычный
        // ответ со статусом 3xx — так же, как это делает httpsTransport, и
        // клиент выше видит одну и ту же BankHttpError вместо двух разных форм
        redirect: 'manual',
        signal,
      })
      return { status: res.status, ok: res.ok, text: () => res.text() }
    },
  }
}
