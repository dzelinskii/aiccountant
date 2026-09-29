import { expect, test, vi } from 'vitest'
import type { FetchImpl } from '../http/bank-client'
import { fetchTransport, type Transport } from '../http/transport'
import { BANK_NAMES, pluginFor } from './registry'

function anyTransport(): Transport {
  return fetchTransport(vi.fn(async () => new Response('{}')) as unknown as FetchImpl)
}

test('плагин находится по имени банка', async () => {
  const plugin = await pluginFor('tbank', { transport: async () => anyTransport() })
  expect(plugin.name).toBe('tbank')
})

test('незнакомое имя банка — понятная ошибка со списком известных, транспорт не запрошен', async () => {
  const transport = vi.fn(async () => anyTransport())
  await expect(pluginFor('unknown-bank', { transport })).rejects.toThrowError(/unknown-bank.*tbank/)
  expect(transport).not.toHaveBeenCalled()
})

test('имя из прототипа объекта — та же понятная ошибка', async () => {
  const deps = { transport: async () => anyTransport() }
  await expect(pluginFor('toString', deps)).rejects.toThrowError(/toString/)
  await expect(pluginFor('constructor', deps)).rejects.toThrowError(/constructor/)
})

test('транспорт запрашивается ровно для своего банка и ровно один раз', async () => {
  for (const name of BANK_NAMES) {
    const transport = vi.fn(async () => anyTransport())
    const plugin = await pluginFor(name, { transport })
    expect(plugin.name).toBe(name)
    expect(transport.mock.calls).toEqual([[name]])
  }
})
