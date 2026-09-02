import { expect, test, vi } from 'vitest'
import { AllowlistClient, NotAllowedError } from './allowlist-client'

const ALLOWED = ['/api/common/v1/session_status']

function clientWith(fetchImpl: typeof fetch) {
  return new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowedPaths: ALLOWED,
    token: 'token',
    fetchImpl,
  })
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
    allowedPaths: ['//evil.example/x'],
    token: 'token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  await expect(client.getJson('//evil.example/x')).rejects.toBeInstanceOf(NotAllowedError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('у клиента нет методов записи', () => {
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
  expect(init?.redirect).toBe('error')
})

test('запрос сопровождается сигналом отмены', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await client.getJson('/api/common/v1/session_status')
  const init = fetchImpl.mock.calls[0]?.[1]
  expect(init?.signal).toBeInstanceOf(AbortSignal)
})

test(
  'таймаут прерывает зависшее тело ответа, а не только фазу заголовков',
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
      allowedPaths: ALLOWED,
      token: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    })
    await expect(client.getJson('/api/common/v1/session_status')).rejects.toThrow()
  },
  2000,
)

test('редирект на чужой хост не превращается в ответ — клиент падает, а не переходит', async () => {
  // симулируем самое опасное: банк отвечает 302 с Location на чужой origin.
  // даже если бы fetchImpl (например, инструментированный) не уважал
  // redirect: 'error' и вернул такой ответ как есть, клиент не должен
  // трактовать его как успех
  const fetchImpl = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/steal?sessionid=leaked-token' },
      }),
  )
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toThrow()
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
    allowedPaths: ALLOWED,
    token: TOKEN,
    fetchImpl: vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
  })
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toSatisfy(
    (e: Error) => !e.message.includes(TOKEN) && !(e.stack ?? '').includes(TOKEN),
  )
})

test('ошибка самого fetchImpl не пробрасывается как есть', async () => {
  // fetchImpl — публичный параметр конструктора; инструментированная
  // реализация может положить URL (с токеном в query) в текст своей ошибки
  const TOKEN = 'SEKRET-SESSION-VALUE-DO-NOT-LEAK'
  const fetchImpl = vi.fn(async () => {
    throw new Error(`fetch failed: https://bank.example/api/common/v1/session_status?sessionid=${TOKEN}`)
  })
  const client = new AllowlistClient({
    baseUrl: 'https://bank.example',
    allowedPaths: ALLOWED,
    token: TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
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
