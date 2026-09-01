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

test('токен не попадает в текст ошибки', async () => {
  const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
  const client = clientWith(fetchImpl as unknown as typeof fetch)
  await expect(client.getJson('/api/common/v1/session_status')).rejects.toThrow(
    expect.not.stringContaining('token') as unknown as string,
  )
})
