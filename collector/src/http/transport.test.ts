import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:https'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { fetchTransport, httpsTransport } from './transport'

test('транспорт на fetch передаёт метод, заголовки и тело', async () => {
  const seen: { method?: string; headers?: Record<string, string>; body?: string } = {}
  const fake: typeof fetch = async (url, init) => {
    seen.method = init?.method
    seen.headers = init?.headers as Record<string, string>
    seen.body = init?.body as string
    return new Response('{"ok":true}', { status: 200 })
  }

  const transport = fetchTransport(fake)
  const res = await transport.send(new URL('https://example.test/api'), {
    method: 'POST',
    headers: { Cookie: 'a=1' },
    body: '{"x":1}',
    signal: AbortSignal.timeout(1000),
  })

  expect(seen.method).toBe('POST')
  expect(seen.headers).toEqual({ Cookie: 'a=1' })
  expect(seen.body).toBe('{"x":1}')
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('{"ok":true}')
})

test('транспорт на fetch не следует за редиректом сам, а отдаёт статус как есть', async () => {
  const fake: typeof fetch = async (_url, init) => {
    expect(init?.redirect).toBe('manual')
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example/x' } })
  }

  const transport = fetchTransport(fake)
  const res = await transport.send(new URL('https://example.test/api'), {
    method: 'GET',
    headers: {},
    signal: AbortSignal.timeout(1000),
  })

  expect(res.status).toBe(302)
  expect(res.ok).toBe(false)
})

// --- httpsTransport: тот же контракт, но поверх настоящего TLS-соединения с
// самоподписанным сертификатом — ровно то, с чем транспорт работает в бою у
// Сбербанка. Сертификат и ключ сгенерированы один раз (openssl req -x509,
// SAN DNS:localhost + IP:127.0.0.1, срок 100 лет) и лежат фикстурой, потому
// что node:crypto не умеет выпускать X.509 без ручной сборки ASN.1

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url)), 'utf-8')
}

const SERVER_CERT = fixture('https-test-cert.pem')
const SERVER_KEY = fixture('https-test-key.pem')
// сертификат другого, никак не связанного с сервером удостоверяющего центра —
// им проверяется, что клиент не доверяет чужому корню
const OTHER_CA_CERT = fixture('https-test-other-ca-cert.pem')

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let activeServer: Server | undefined

afterEach(async () => {
  if (!activeServer) return
  const server = activeServer
  activeServer = undefined
  // некоторые тесты рвут соединение руками — незакрытый сокет держал бы
  // server.close() вечно
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function startServer(handler: Handler): Promise<URL> {
  const server = createServer({ cert: SERVER_CERT, key: SERVER_KEY }, handler)
  activeServer = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('не удалось поднять тестовый сервер')
  return new URL(`https://127.0.0.1:${address.port}/`)
}

test('httpsTransport: успешный GET', async () => {
  const url = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })

  const transport = httpsTransport(SERVER_CERT)
  const res = await transport.send(url, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) })

  expect(res.status).toBe(200)
  expect(res.ok).toBe(true)
  expect(await res.text()).toBe('{"ok":true}')
})

test('httpsTransport: успешный POST уходит с Content-Length, а не chunked', async () => {
  const seen: { contentLength?: string; transferEncoding?: string; body: string } = { body: '' }
  const url = await startServer((req, res) => {
    seen.contentLength = req.headers['content-length']
    seen.transferEncoding = req.headers['transfer-encoding']
    req.setEncoding('utf-8')
    req.on('data', (chunk: string) => {
      seen.body += chunk
    })
    req.on('end', () => {
      res.writeHead(200)
      res.end('{"ok":true}')
    })
  })

  const transport = httpsTransport(SERVER_CERT)
  const res = await transport.send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"x":1}',
    signal: AbortSignal.timeout(2000),
  })

  expect(res.status).toBe(200)
  expect(seen.contentLength).toBe(String(Buffer.byteLength('{"x":1}')))
  expect(seen.transferEncoding).toBeUndefined()
  expect(seen.body).toBe('{"x":1}')
})

test(
  'httpsTransport: обрыв тела на середине реджектит промис, а не подвешивает его навсегда',
  async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('часть тела, дальше связь оборвётся')
      // socket.end(), а не destroy(): это чистое закрытие (FIN, без RST) —
      // ровно та форма обрыва, при которой node:https не эмитит 'error' на
      // req (RST дал бы ECONNRESET и там, что не воспроизводило бы дефект).
      // Сигнал приходит только через 'error'/'close' на самом res
      res.socket?.end()
    })

    const transport = httpsTransport(SERVER_CERT)
    await expect(
      transport.send(url, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow()
  },
  5000,
)

test(
  'httpsTransport: таймаут прерывает зависшее тело ответа, а не только фазу заголовков',
  async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('заголовки пришли, тело — никогда')
      // тело намеренно не закрываем и сокет не рвём: соединение просто
      // висит, как будто банк "задумался"
    })

    const transport = httpsTransport(SERVER_CERT)
    await expect(
      transport.send(url, { method: 'GET', headers: {}, signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow()
  },
  5000,
)

test('httpsTransport: отказ соединения — понятная ошибка, а не зависание', async () => {
  // порт получаем у реального сервера и тут же освобождаем — соединяться
  // будем туда, где заведомо никто не слушает
  const probe = createServer({ cert: SERVER_CERT, key: SERVER_KEY })
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('не удалось выбрать порт')
  const port = address.port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  const transport = httpsTransport(SERVER_CERT)
  await expect(
    transport.send(new URL(`https://127.0.0.1:${port}/`), {
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(2000),
    }),
  ).rejects.toThrow()
})

test('httpsTransport: недоверенный сертификат отклоняется, а не подключается', async () => {
  const url = await startServer((_req, res) => {
    res.writeHead(200)
    res.end('этот ответ клиент получить не должен')
  })

  // передаём корень чужого, никак не связанного УЦ: сертификат сервера
  // подписан не им, проверка обязана провалиться до отправки запроса
  const transport = httpsTransport(OTHER_CA_CERT)
  await expect(
    transport.send(url, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) }),
  ).rejects.toThrow()
})

test('httpsTransport: ответ 302 возвращается статусом, тело не буферизуется', async () => {
  const url = await startServer((_req, res) => {
    res.writeHead(302, { Location: 'https://evil.example/steal' })
    res.end('тело редиректа буферизовать не нужно')
  })

  const transport = httpsTransport(SERVER_CERT)
  const res = await transport.send(url, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) })

  expect(res.status).toBe(302)
  expect(res.ok).toBe(false)
  // статус вне 2xx — тело сливается (res.resume()), а не копится в памяти
  expect(await res.text()).toBe('')
})
