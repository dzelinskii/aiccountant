import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { AllowlistClient, BankHttpError, NotAllowedError } from './allowlist-client'
import { fetchTransport, httpsTransport } from './transport'
import type { Transport } from './transport'

const ALLOWED = [{ path: '/api/common/v1/session_status', method: 'GET' as const }]
const CREDENTIALS = { kind: 'query' as const, name: 'sessionid', value: 'token' }

function clientWith(fetchImpl: typeof fetch) {
  return new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowed: ALLOWED,
    credentials: CREDENTIALS,
    transport: fetchTransport(fetchImpl),
  })
}

function recordingTransport(body = '{"ok":true}'): {
  transport: Transport
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[]
} {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const transport: Transport = {
    async send(url, options) {
      calls.push({ url: url.toString(), method: options.method, headers: options.headers, body: options.body })
      return { status: 200, ok: true, text: async () => body }
    },
  }
  return { transport, calls }
}

test('разрешённый путь уходит в сеть', async () => {
  const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await client.getJson('/api/common/v1/session_status')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('путь вне списка не доходит до сети', async () => {
  const fetchImpl = vi.fn()
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/transfer')).rejects.toBeInstanceOf(NotAllowedError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('чужой хост не доходит до сети', async () => {
  const fetchImpl = vi.fn()
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(
    client.getJson('https://evil.example/api/common/v1/session_status'),
  ).rejects.toBeInstanceOf(NotAllowedError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('проверка origin реально отрабатывает, а не маскируется проверкой пути', async () => {
  // предыдущий тест отсекается уже на allowlist пути (полный URL не совпадает
  // ни с одной строкой из списка) — проверка origin в нём не участвует.
  // здесь путь протокольно-относительный ("//evil.example/x"), поэтому проходит
  // allowlist как строка, но при разрешении относительно baseUrl указывает
  // на чужой хост — и должен быть отбит именно проверкой origin
  const fetchImpl = vi.fn()
  const client = new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowed: [{ path: '//evil.example/x', method: 'GET' }],
    credentials: CREDENTIALS,
    transport: fetchTransport(fetchImpl as unknown as typeof fetch),
  })
  await expect(client.getJson('//evil.example/x')).rejects.toBeInstanceOf(NotAllowedError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('у клиента нет методов записи мимо postJson', () => {
  const client = clientWith(vi.fn() as unknown as typeof fetch)
  const asRecord = client as unknown as Record<string, unknown>
  expect(asRecord.post).toBeUndefined()
  expect(asRecord.put).toBeUndefined()
  expect(asRecord.delete).toBeUndefined()
})

test('запрос уходит именно методом GET', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await client.getJson('/api/common/v1/session_status')
  const init = fetchImpl.mock.calls[0]?.[1]
  expect(init?.method).toBe('GET')
})

test('запрос запрещает автоследование за редиректом', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await client.getJson('/api/common/v1/session_status')
  const init = fetchImpl.mock.calls[0]?.[1]
  // 'manual', а не 'error': переход по-прежнему не происходит, но статус
  // 3xx доходит наверх обычным ответом — см. следующий тест
  expect(init?.redirect).toBe('manual')
})

test('запрос сопровождается сигналом отмены', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await client.getJson('/api/common/v1/session_status')
  const init = fetchImpl.mock.calls[0]?.[1]
  expect(init?.signal).toBeInstanceOf(AbortSignal)
})

test(
  // название описывает не то, что здесь проверяется: обрыв чтения тела при
  // срабатывании сигнала здесь реализует сам фейковый fetchImpl (см. его
  // обработчик abort ниже), а не транспорт под проверкой. Тест на деле
  // подтверждает, что таймер AllowlistClient (см. комментарий у fetchText)
  // не гасится к моменту чтения тела, а продолжает действовать и после
  // получения заголовков
  'сигнал таймаута AllowlistClient остаётся рабочим и во время чтения тела, не только до получения заголовков',
  async () => {
    // заголовки пришли (fetchImpl уже зарезолвился), а тело — нет: банк
    // "задумался" на середине выписки или мобильная сеть оборвалась.
    // stream ничего не enqueue-ит и не закрывается сам по себе
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      // так реальный fetch/undici рвёт именно тело ответа при срабатывании
      // signal — это и проверяем: что клиент реально передаёт сигнал дальше
      // и что он способен оборвать чтение, а не только факт его наличия
      init?.signal?.addEventListener('abort', () => {
        streamController?.error(new Error('aborted'))
      })
      return Promise.resolve(new Response(stream))
    })
    const client = new AllowlistClient({
      baseUrl: 'https://bank.example',
      allowed: ALLOWED,
      credentials: CREDENTIALS,
      transport: fetchTransport(fetchImpl as unknown as typeof fetch),
      timeoutMs: 20,
    })
    await expect(client.getJson('/api/common/v1/session_status')).rejects.toThrow()
  },
  2000,
)

test('редирект на чужой хост не превращается в переход — клиент получает BankHttpError(302)', async () => {
  // симулируем самое опасное: банк отвечает 302 с Location на чужой origin.
  // redirect: 'manual' не идёт по Location сам (единственный вызов fetchImpl
  // ниже это подтверждает) и отдаёт 3xx обычным ответом — клиент обязан
  // трактовать его как типизированную ошибку, а не как успех
  const fetchImpl = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/steal?sessionid=leaked-token' },
      }),
  )
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toSatisfy(
    (e: unknown) => e instanceof BankHttpError && e.status === 302,
  )
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('при not-ok ответе тело не читается', async () => {
  // порядок проверок важен сам по себе: тело ответа банка не нужно читать,
  // если запрос и так отклонён по статусу
  const textSpy = vi.fn(() => {
    throw new Error('text() не должен вызываться до проверки res.ok')
  })
  const fakeRes = { ok: false, status: 500, text: textSpy } as unknown as Response
  const fetchImpl = vi.fn(async () => fakeRes)
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toThrow('Банк ответил 500')
  expect(textSpy).not.toHaveBeenCalled()
})

test('токен не попадает в текст ошибки при not-ok ответе', async () => {
  const TOKEN = 'SEKRET-SESSION-VALUE-DO-NOT-LEAK'
  const client = new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowed: ALLOWED,
    credentials: { kind: 'query', name: 'sessionid', value: TOKEN },
    transport: fetchTransport(vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch),
  })
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toSatisfy(
    (e: Error) => !e.message.includes(TOKEN) && !(e.stack ?? '').includes(TOKEN),
  )
})

test('ошибка самого fetchImpl не пробрасывается как есть', async () => {
  // транспорт — публичный параметр конструктора; инструментированная
  // реализация может положить URL (с токеном в query) в текст своей ошибки
  const TOKEN = 'SEKRET-SESSION-VALUE-DO-NOT-LEAK'
  const fetchImpl = vi.fn(async () => {
    throw new Error(`fetch failed: https://bank.example/api/common/v1/session_status?sessionid=${TOKEN}`)
  })
  const client = new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowed: ALLOWED,
    credentials: { kind: 'query', name: 'sessionid', value: TOKEN },
    transport: fetchTransport(fetchImpl as unknown as typeof fetch),
  })
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toSatisfy(
    (e: Error) => !e.message.includes(TOKEN),
  )
})

test('сетевые сбои различимы по имени ошибки и коду причины, а не схлопнуты в одно сообщение', async () => {
  // ни e.name, ни cause.code URL или токен не содержат — их можно безопасно
  // показать, чтобы заблокированный редирект не выглядел как обрыв DNS
  const dnsError = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
  const fetchImpl = vi.fn(async () => {
    throw dnsError
  })
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toSatisfy(
    (e: Error) => e.message.includes('TypeError') && e.message.includes('ENOTFOUND'),
  )
})

test('сетевые сбои различимы и для транспорта в форме node:https, где код лежит прямо на ошибке', async () => {
  // undici (fetchTransport) кладёт код причины в e.cause.code, а node:https
  // (httpsTransport) — прямо в e.code, без cause вообще (проверено руками:
  // реальная ошибка connect ECONNREFUSED от node:https имеет именно такую
  // форму, включая e.name === 'Error' — у Error-наследников name не
  // становится именем класса сам по себе)
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
  const transport: Transport = {
    send: vi.fn(async () => {
      throw refused
    }),
  }
  const client = new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowed: ALLOWED,
    credentials: CREDENTIALS,
    transport,
  })
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toSatisfy(
    (e: Error) => e.message.includes('Error') && e.message.includes('ECONNREFUSED'),
  )
})

test('таймаут httpsTransport доходит до текста ошибки клиента как ETIMEDOUT, а не безымянной "(Error)"', async () => {
  // сквозной сценарий через настоящий TLS-сервер: без кода на ошибке таймаута
  // (см. abortError в transport.ts) describeCause показал бы голое "(Error)" —
  // самый частый отказ банка остался бы единственным нечитаемым в списке
  // остальных (ECONNREFUSED, ENOTFOUND, недоверенный сертификат)
  const cert = readFileSync(fileURLToPath(new URL('../../tests/fixtures/https-test-cert.pem', import.meta.url)), 'utf-8')
  const key = readFileSync(fileURLToPath(new URL('../../tests/fixtures/https-test-key.pem', import.meta.url)), 'utf-8')
  const server = createServer({ cert, key }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // тело намеренно не закрываем — банк "задумался"
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('не удалось поднять тестовый сервер')

  try {
    const client = new AllowlistClient({
      baseUrl: `https://127.0.0.1:${address.port}`,
      allowed: ALLOWED,
      credentials: CREDENTIALS,
      transport: httpsTransport(cert),
      timeoutMs: 50,
    })
    await expect(client.getJson('/api/common/v1/session_status')).rejects.toThrow(/ETIMEDOUT/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('текст ответа не пробрасывается при ошибке разбора', async () => {
  // частый штатный случай: протухшая сессия — банк вместо JSON отдаёт
  // HTML-страницу логина с описанием операций где-то на странице
  const html = '<html><body>сессия истекла, номер операции 12345</body></html>'
  const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toSatisfy(
    (e: Error) => !e.message.includes('сессия истекла') && !e.message.includes('12345'),
  )
})

test('секрет-заголовок уходит в заголовках, а не в адресе', async () => {
  const { transport, calls } = recordingTransport()
  const client = new AllowlistClient({
    baseUrl: 'https://bank.test',
    allowed: [{ path: '/data', method: 'POST' }],
    credentials: { kind: 'header', name: 'Cookie', value: 'SESSION=secret' },
    transport,
  })

  await client.postJson('/data', { page: 1 })

  expect(calls[0]?.headers['Cookie']).toBe('SESSION=secret')
  expect(calls[0]?.url).not.toContain('secret')
  expect(calls[0]?.body).toBe('{"page":1}')
})

test('вариант headers шлёт все заголовки сразу, а не только один', async () => {
  // Альфе на POST нужны и Cookie, и производный X-XSRF-TOKEN. Если код кладёт
  // лишь один из них (как хватало Сберу), этот тест падает
  const { transport, calls } = recordingTransport()
  const client = new AllowlistClient({
    baseUrl: 'https://bank.test',
    allowed: [{ path: '/data', method: 'POST' }],
    credentials: { kind: 'headers', headers: { Cookie: 'GW_SESSION_AO=s', 'X-XSRF-TOKEN': 'x' } },
    transport,
  })

  await client.postJson('/data', { page: 1 })

  expect(calls[0]?.headers['Cookie']).toBe('GW_SESSION_AO=s')
  expect(calls[0]?.headers['X-XSRF-TOKEN']).toBe('x')
  expect(calls[0]?.headers['Accept']).toBe('application/json')
  expect(calls[0]?.url).not.toContain('GW_SESSION_AO')
})

test('POST по пути, разрешённому только для GET, не отправляется', async () => {
  const { transport, calls } = recordingTransport()
  const client = new AllowlistClient({
    baseUrl: 'https://bank.test',
    allowed: [{ path: '/data', method: 'GET' }],
    credentials: { kind: 'header', name: 'Cookie', value: 'SESSION=secret' },
    transport,
  })

  await expect(client.postJson('/data', {})).rejects.toBeInstanceOf(NotAllowedError)
  expect(calls).toHaveLength(0)
})
