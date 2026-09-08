import { expect, test } from 'vitest'
import { fetchTransport } from './transport'

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
