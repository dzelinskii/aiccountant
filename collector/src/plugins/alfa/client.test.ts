import { expect, test } from 'vitest'
import { NotAllowedError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import { ACCOUNTS_PATH, OPERATIONS_PATH, createAlfaClient } from './client'

function recordingTransport(): { transport: Transport; calls: { headers: Record<string, string> }[] } {
  const calls: { headers: Record<string, string> }[] = []
  const transport: Transport = {
    async send(_url, options) {
      calls.push({ headers: options.headers })
      return { status: 200, ok: true, text: async () => '{"ok":true}' }
    },
  }
  return { transport, calls }
}

const COOKIE = 'GW_SESSION_AO=sess; XSRF-TOKEN=xsrf-abc'

test('X-XSRF-TOKEN на POST равен куке XSRF-TOKEN, Cookie уходит целиком', async () => {
  const { transport, calls } = recordingTransport()
  const client = createAlfaClient({ kind: 'header', name: 'Cookie', value: COOKIE }, { ca: 'unused', transport })

  await client.postJson(OPERATIONS_PATH, { size: 1, page: 1, forced: false, filters: [] })

  expect(calls[0]?.headers['Cookie']).toBe(COOKIE)
  expect(calls[0]?.headers['X-XSRF-TOKEN']).toBe('xsrf-abc')
})

test('без XSRF-TOKEN в куке клиент не собирается — понятная ошибка', () => {
  expect(() =>
    createAlfaClient({ kind: 'header', name: 'Cookie', value: 'GW_SESSION_AO=sess' }, { ca: 'unused' }),
  ).toThrow(/XSRF-TOKEN/)
})

test('секрет не той формы (query) отвергается', () => {
  expect(() => createAlfaClient({ kind: 'query', name: 'token', value: 'x' }, { ca: 'unused' })).toThrow(/заголовк/i)
})

test('allowlist: POST-путь нельзя дёрнуть методом GET', async () => {
  const { transport } = recordingTransport()
  const client = createAlfaClient({ kind: 'header', name: 'Cookie', value: COOKIE }, { ca: 'unused', transport })
  await expect(client.getJson(OPERATIONS_PATH)).rejects.toBeInstanceOf(NotAllowedError)
})

test('allowlist: неразрешённый путь до сети не доходит', async () => {
  const { transport, calls } = recordingTransport()
  const client = createAlfaClient({ kind: 'header', name: 'Cookie', value: COOKIE }, { ca: 'unused', transport })
  await expect(client.getJson('/api/v1/transfers/new')).rejects.toBeInstanceOf(NotAllowedError)
  await client.getJson(ACCOUNTS_PATH)
  expect(calls).toHaveLength(1)
})
