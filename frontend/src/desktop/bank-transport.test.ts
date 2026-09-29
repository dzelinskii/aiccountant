import { beforeEach, expect, test, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('./runtime', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { bankTransport } from './bank-transport'

beforeEach(() => invoke.mockReset())

function get(url = 'https://x/') {
  return bankTransport('sber').send(new URL(url), {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
  })
}

test('запрос уходит в оболочку целиком, ответ собирается обратно', async () => {
  invoke.mockResolvedValueOnce({ status: 200, body: '{"a":1}' })
  const res = await bankTransport('sber').send(new URL('https://web-node3.online.sberbank.ru/x'), {
    method: 'POST',
    headers: { Cookie: 'c' },
    body: '{}',
    signal: new AbortController().signal,
  })
  expect(invoke).toHaveBeenCalledWith('bank_request', {
    bank: 'sber',
    method: 'POST',
    url: 'https://web-node3.online.sberbank.ru/x',
    headers: { Cookie: 'c' },
    body: '{}',
  })
  expect(res.ok).toBe(true)
  expect(await res.text()).toBe('{"a":1}')
})

test('не-2xx — ok ложно, статус сохранён', async () => {
  invoke.mockResolvedValueOnce({ status: 403, body: '' })
  const res = await get()
  expect(res.ok).toBe(false)
  expect(res.status).toBe(403)
})

test('GET без тела уходит с body null, а не undefined', async () => {
  invoke.mockResolvedValueOnce({ status: 200, body: '' })
  await get()
  const args = invoke.mock.calls[0]![1] as Record<string, unknown>
  expect(args).toHaveProperty('body', null)
})

test.each([
  [199, false],
  [200, true],
  [204, true],
  [299, true],
  [300, false],
])('статус %i: ok = %s', async (status, ok) => {
  invoke.mockResolvedValueOnce({ status, body: '' })
  const res = await get()
  expect(res.status).toBe(status)
  expect(res.ok).toBe(ok)
})

test('отказ оболочки пробрасывается', async () => {
  invoke.mockRejectedValueOnce(new Error('адрес не из списка банка'))
  await expect(get()).rejects.toThrow('адрес не из списка банка')
})
