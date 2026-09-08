import { request as httpsRequest } from 'node:https'

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

// таймауту (и любой другой отмене сигнала) присваивается код: без него
// describeCause в allowlist-client показывает голое "(Error)" — самый частый
// сетевой отказ на бою оставался бы единственным нечитаемым
function abortError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('Таймаут запроса')
  error.code = 'ETIMEDOUT'
  return error
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
        // сигнал может прийти уже отменённым: AllowlistClient создаёт
        // контроллер заново на каждый запрос, но обёртка с повторными
        // попытками поверх общего сигнала — штатный способ дожимать банк, и
        // тогда отменённый сигнал будет доходить сюда. Без этой проверки
        // 'abort' на уже отменённом сигнале никогда не срабатывает, запрос
        // уходит в сеть и висит, пока не ответит молчащий сервер
        if (signal.aborted) {
          reject(abortError())
          return
        }

        // и resolve, и reject могут сработать больше одного раза за жизнь
        // запроса — на одном и том же обрыве соединения нередко срабатывают
        // оба обработчика, 'error' и 'close' на res, один за другим — промис
        // разрешается только первым срабатыванием, остальные молча гасятся
        let settled = false
        const settle = (fn: () => void) => {
          if (settled) return
          settled = true
          fn()
        }

        const req = httpsRequest(
          url,
          {
            method,
            ca,
            // без Content-Length Node уходит в chunked-кодирование, а многие
            // банковские фронты его отбивают — тело у нас всегда известной
            // длины заранее, потоковой отправки здесь не бывает
            headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
          },
          (res) => {
            const status = res.statusCode ?? 0
            // редирект node:https сам не проходит, но и ошибкой не считает —
            // 3xx возвращается обычным ответом, проверка на стороне клиента
            // (см. allowlist-client)
            const ok = status >= 200 && status < 300
            let text = ''
            if (ok) {
              res.setEncoding('utf-8')
              res.on('data', (chunk: string) => {
                text += chunk
              })
            } else {
              // тело ответа с ошибочным статусом клиенту не нужно — сливаем
              // поток, а не копим в памяти то, что всё равно будет отброшено
              res.resume()
            }
            res.on('end', () => {
              settle(() => resolve({ status, ok, text: async () => text }))
            })
            res.on('error', (err) => settle(() => reject(err)))
            // измерено: во всех проверенных формах обрыва (и FIN, и RST)
            // первым срабатывает 'error' с ECONNRESET, и эта ветка на
            // нынешнем Node недостижима. Она остаётся страховкой на случай
            // смены поведения: документация Node называет res.complete по
            // 'close' основным способом отличить полный ответ от обрыва, а
            // не 'error' — если это когда-нибудь станет верным и здесь, без
            // проверки промис завис бы навсегда и pnpm collect молчал бы
            res.on('close', () => {
              if (!res.complete) {
                settle(() => reject(new Error('Соединение с банком оборвалось до конца ответа')))
              }
            })
          },
        )
        req.on('error', (err) => settle(() => reject(err)))
        signal.addEventListener('abort', () => req.destroy(abortError()), { once: true })
        if (body !== undefined) req.write(body)
        req.end()
      })
    },
  }
}
