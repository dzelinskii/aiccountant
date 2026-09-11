import { expect, test } from 'vitest'
import type { Transport } from '../../http/transport'
import { createAlfaPlugin } from './index'

const CRED = { kind: 'header' as const, name: 'Cookie', value: 'GW_SESSION_AO=s; XSRF-TOKEN=x' }

interface Routes {
  account?: { status: number; body?: string }
  cards?: string
  // операции по номеру страницы из тела запроса
  operationsByPage?: (page: number) => string
}

function routingTransport(routes: Routes): { transport: Transport; posts: unknown[] } {
  const posts: unknown[] = []
  const transport: Transport = {
    async send(url, options) {
      const path = url.pathname
      if (path === '/api/v1/account/') {
        const r = routes.account ?? { status: 200, body: '{"accounts":[]}' }
        return { status: r.status, ok: r.status < 300, text: async () => r.body ?? '{}' }
      }
      if (path === '/api/v1/cards/masked-cards') {
        return { status: 200, ok: true, text: async () => routes.cards ?? '{"cards":[]}' }
      }
      if (path === '/api/v1/operations-history/operations') {
        const body = JSON.parse(options.body ?? '{}')
        posts.push(body)
        return { status: 200, ok: true, text: async () => (routes.operationsByPage ?? (() => '{"operations":[]}'))(body.page) }
      }
      throw new Error(`неожиданный путь ${path}`)
    },
  }
  return { transport, posts }
}

function pluginWith(routes: Routes) {
  const { transport, posts } = routingTransport(routes)
  return { plugin: createAlfaPlugin({ ca: 'unused', transport }), posts }
}

test('isAlive: 200 — жива, 302 — мертва, прочий статус — проброс', async () => {
  const alive = pluginWith({ account: { status: 200, body: '{"accounts":[]}' } }).plugin
  expect(await alive.isAlive(CRED)).toBe(true)

  const dead = pluginWith({ account: { status: 302 } }).plugin
  expect(await dead.isAlive(CRED)).toBe(false)

  const broken = pluginWith({ account: { status: 500 } }).plugin
  await expect(broken.isAlive(CRED)).rejects.toThrow()
})

test('fetchAccounts тянет и счета, и карты и сводит их', async () => {
  const { plugin } = pluginWith({
    account: {
      status: 200,
      body: '{"accounts":[{"number":"40817810000000002905","description":"Текущий счёт","type":"EE","total":{"value":42600000,"currency":"RUR","minorUnits":100}}]}',
    },
    cards: '{"cards":[{"number":"220015******0149","account":{"number":"40817810000000002905"}}]}',
  })
  const accounts = await plugin.fetchAccounts(CRED)
  expect(accounts).toHaveLength(1)
  expect(accounts[0]).toMatchObject({ id: '40817810000000002905', balance: '426000.00', cardMasks: ['0149'] })
})

test('fetchOperations листает до короткой страницы и шлёт фильтр по счёту и даты', async () => {
  const page1 = JSON.stringify({
    operations: Array.from({ length: 100 }, (_v, i) => ({
      id: `p1-${i}`,
      dateTime: '2026-09-10T10:00:00.000+0300',
      title: 'x',
      amount: { value: 100, currency: 'RUR', minorUnits: 100 },
      direction: 'EXPENSE',
    })),
  })
  const page2 = JSON.stringify({
    operations: [
      { id: 'p2-0', dateTime: '2026-09-10T10:00:00.000+0300', title: 'x', amount: { value: 100, currency: 'RUR', minorUnits: 100 }, direction: 'EXPENSE' },
    ],
  })
  const { plugin, posts } = pluginWith({ operationsByPage: (page) => (page === 1 ? page1 : page2) })

  const since = Date.parse('2026-08-01T00:00:00+03:00')
  const until = Date.parse('2026-08-31T23:00:00+03:00')
  const ops = await plugin.fetchOperations(CRED, '40817810000000002905', since, until)

  expect(ops).toHaveLength(101) // 100 + 1, обход остановился на короткой странице
  expect(posts).toHaveLength(2)
  expect(posts[0]).toMatchObject({
    size: 100,
    page: 1,
    from: '2026-08-01',
    to: '2026-08-31',
    filters: [{ type: 'accounts', values: ['40817810000000002905'] }],
  })
})

test('банк вернул историю не массивом — сбор падает, не молчит', async () => {
  const { plugin } = pluginWith({ operationsByPage: () => '{"operations":"нет"}' })
  await expect(plugin.fetchOperations(CRED, '1', 0, 1)).rejects.toThrow(/историю не массивом/)
})
