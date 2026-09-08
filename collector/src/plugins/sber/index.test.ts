import { expect, test } from 'vitest'
import { BankHttpError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import { SBER_ALLOWED } from './client'
import { createSberPlugin, toSberDate } from './index'

const CREDENTIALS = { kind: 'header', name: 'Cookie', value: 'UFS-SESSION=a; UFS-TOKEN=b' } as const

function operation(index: number): Record<string, unknown> {
  return {
    uohId: `id-${index}`,
    date: '08.09.2026T11:23:45',
    form: 'ExtCardPayment',
    isFinancial: true,
    fromResource: { id: 'card:1', displayedValue: 'Карта •• 1234' },
    operationAmount: { amount: -10, currencyCode: 'RUB' },
  }
}

/** Транспорт, отвечающий заранее заданными страницами операций. */
function pagingTransport(pages: number[]): { transport: Transport; bodies: string[] } {
  const bodies: string[] = []
  let call = 0
  const transport: Transport = {
    async send(_url, options) {
      bodies.push(options.body ?? '')
      const count = pages[call] ?? 0
      call += 1
      const operations = Array.from({ length: count }, (_, i) => operation(i))
      return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, body: { operations } }) }
    },
  }
  return { transport, bodies }
}

test('дата переводится в формат банка по московскому времени', () => {
  // 2026-09-08T21:30:00Z — это уже 9 сентября по Москве
  expect(toSberDate(Date.UTC(2026, 8, 8, 21, 30, 0))).toBe('09.09.2026T00:30:00')
})

test('полная страница вызывает запрос следующей', async () => {
  const { transport, bodies } = pagingTransport([250, 250, 7])
  const plugin = createSberPlugin({ ca: '', transport })
  const operations = await plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)

  expect(operations).toHaveLength(507)
  expect(bodies).toHaveLength(3)
  expect(JSON.parse(bodies[1] ?? '{}').paginationOffset).toBe(250)
})

test('неполная страница завершает обход', async () => {
  const { transport, bodies } = pagingTransport([3])
  const plugin = createSberPlugin({ ca: '', transport })
  await plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)
  expect(bodies).toHaveLength(1)
})

test('запрос истории фильтруется по карте и по периоду', async () => {
  const { transport, bodies } = pagingTransport([0])
  const plugin = createSberPlugin({ ca: '', transport })
  await plugin.fetchOperations(CREDENTIALS, 'card:1', Date.UTC(2026, 8, 1, 0, 0, 0), Date.UTC(2026, 8, 8, 0, 0, 0))

  const sent = JSON.parse(bodies[0] ?? '{}')
  expect(sent.usedResource).toEqual(['card:1'])
  expect(sent.paginationSize).toBe(250)
  expect(sent.from).toMatch(/^\d{2}\.\d{2}\.\d{4}T\d{2}:\d{2}:\d{2}$/)
  expect(sent.to).toMatch(/^\d{2}\.\d{2}\.\d{4}T\d{2}:\d{2}:\d{2}$/)
})

test('403 означает мёртвую сессию, а не сбой', async () => {
  const transport: Transport = {
    async send() {
      return { status: 403, ok: false, text: async () => '' }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })
  expect(await plugin.isAlive(CREDENTIALS)).toBe(false)
})

test('прочие ошибки банка не выдаются за протухшую сессию', async () => {
  const transport: Transport = {
    async send() {
      return { status: 500, ok: false, text: async () => '' }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })
  await expect(plugin.isAlive(CREDENTIALS)).rejects.toBeInstanceOf(BankHttpError)
})

test('секрет не той формы отвергается понятной ошибкой', async () => {
  const plugin = createSberPlugin({ ca: '', transport: pagingTransport([0]).transport })
  await expect(plugin.fetchAccounts({ kind: 'query', name: 'sessionid', value: 'x' })).rejects.toThrowError(/заголовк/i)
})

test('в allowlist только чтение истории и списка продуктов', () => {
  expect(SBER_ALLOWED.map((endpoint) => endpoint.path)).toEqual([
    '/uoh-bh/v1/operations/list',
    '/main-screen/rest/v2/m1/web/section/meta',
  ])
})
