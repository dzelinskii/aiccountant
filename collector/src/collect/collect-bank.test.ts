import { expect, test, vi } from 'vitest'
import { ACCOUNT_NOTES } from '../core/account-notes'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials } from '../core/contract'
import type { FetchImpl } from './app-api'
import { BankSessionExpiredError, collectBank, type CollectHost, type SessionStore } from './collect-bank'
import { accountFingerprint } from './fingerprint'

const LIVE: Credentials = { kind: 'header', name: 'Cookie', value: 'live' }
const FRESH: Credentials = { kind: 'header', name: 'Cookie', value: 'fresh' }

function account(id: string): CollectedAccount {
  return { id, name: `Счёт ${id}`, type: 'card', currency: 'RUB', balance: '10.00', creditLimit: null, cardMasks: [], notes: [] }
}

function operation(external_id: string): CollectedOperation {
  return {
    occurred_at: '2026-09-01T10:00:00+03:00',
    amount: '-1.00',
    currency: 'RUB',
    description: 'кофе',
    external_id,
    kind: 'purchase',
    category_hint: null,
  }
}

function plugin(overrides: Partial<BankPlugin> = {}): BankPlugin {
  return {
    name: 'sber',
    login: vi.fn(async () => FRESH),
    isAlive: vi.fn(async (c: Credentials) => c.kind === 'header' && (c.value === 'live' || c.value === 'fresh')),
    fetchAccounts: vi.fn(async () => [account('a'), account('b')]),
    fetchOperations: vi.fn(async (_c: Credentials, id: string) => [operation(`${id}-1`)]),
    ...overrides,
  }
}

function sessions(initial: Credentials | null): SessionStore & { saved: Credentials | null } {
  const store = {
    saved: initial,
    async read() {
      return store.saved
    },
    async write(_bank: string, credentials: Credentials) {
      store.saved = credentials
    },
  }
  return store
}

/** Приложение: привязаны только перечисленные счета; импорты создаются с порядковым id. */
async function appFetch(linkedIds: string[], failImportFor: string | null = null, importStatus = 422): Promise<FetchImpl> {
  const linked: Record<string, string> = {}
  for (const id of linkedIds) linked[await accountFingerprint('sber', id)] = `app-${id}`
  let imports = 0
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/accounts/discovered') return new Response(JSON.stringify({ linked }))
    const target = url.searchParams.get('account_id')
    if (target === failImportFor) {
      return new Response(JSON.stringify({ detail: 'Валюта не совпадает' }), { status: importStatus })
    }
    imports += 1
    return new Response(JSON.stringify({ import_id: `imp-${imports}`, status: 'pending' }), { status: 201 })
  }) as unknown as FetchImpl
}

function host(overrides: Partial<CollectHost>): CollectHost {
  return {
    plugin: plugin(),
    sessions: sessions(LIVE),
    prompt: {
      withBrowser: vi.fn(async () => {
        throw new Error('окно не должно открываться')
      }),
    },
    app: { baseUrl: 'http://app.local', workspaceId: 'ws-1', authorization: 'Session t' },
    days: 30,
    now: () => Date.parse('2026-09-29T00:00:00Z'),
    ...overrides,
  }
}

test('живая сессия — вход не нужен, собираются только привязанные счета', async () => {
  const summary = await collectBank(host({ fetchImpl: await appFetch(['a']) }))
  expect(summary.session).toBe('stored')
  expect(summary.accounts).toEqual([
    expect.objectContaining({ appAccountId: 'app-a', collected: 1, importId: 'imp-1', error: null }),
  ])
  expect(summary.unboundCount).toBe(1)
})

test('мёртвая сессия — вход, свежий секрет сохранён, итог говорит о свежем входе', async () => {
  const store = sessions({ kind: 'header', name: 'Cookie', value: 'dead' })
  const summary = await collectBank(host({ sessions: store, fetchImpl: await appFetch(['a']) }))
  expect(summary.session).toBe('login')
  expect(store.saved).toEqual(FRESH)
})

test('банк не признал сессию после входа — ошибка, секрет не сохранён', async () => {
  const store = sessions(null)
  const p = plugin({ isAlive: vi.fn(async () => false) })
  await expect(collectBank(host({ plugin: p, sessions: store, fetchImpl: await appFetch(['a']) }))).rejects.toThrow(
    /не признал/,
  )
  expect(store.saved).toBeNull()
})

test('недоступность банка при проверке сессии — ошибка без входа', async () => {
  const p = plugin({
    isAlive: vi.fn(async () => {
      throw new Error('Банк недоступен (таймаут)')
    }),
  })
  await expect(collectBank(host({ plugin: p, fetchImpl: await appFetch(['a']) }))).rejects.toThrow(/недоступен/)
  expect(p.login).not.toHaveBeenCalled()
})

test('отказ импорта по одному счёту не мешает другому', async () => {
  const summary = await collectBank(host({ fetchImpl: await appFetch(['a', 'b'], 'app-a') }))
  expect(summary.accounts).toEqual([
    expect.objectContaining({ appAccountId: 'app-a', importId: null, error: expect.stringMatching(/422/) }),
    expect.objectContaining({ appAccountId: 'app-b', importId: 'imp-1', error: null }),
  ])
})

test('сессия приложения кончилась на отправке импорта — сбор останавливается целиком, а не по счетам', async () => {
  // сверка счетов проходит, 401 приходит уже из collectAccount: если бы его
  // глотали как отказ одного счёта, сбор вернул бы итог с ошибками по счетам
  const fetchImpl = await appFetch(['a', 'b'], 'app-a', 401)
  await expect(collectBank(host({ fetchImpl }))).rejects.toMatchObject({ status: 401 })
})

test('сессия приложения кончилась на сверке счетов — сбор останавливается до банка', async () => {
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as FetchImpl
  const p = plugin()
  await expect(collectBank(host({ plugin: p, fetchImpl }))).rejects.toMatchObject({ status: 401 })
  expect(p.fetchOperations).not.toHaveBeenCalled()
})

test('ни одного привязанного счёта — операции не запрашиваются', async () => {
  const p = plugin()
  const summary = await collectBank(host({ plugin: p, fetchImpl: await appFetch([]) }))
  expect(summary.accounts).toEqual([])
  expect(summary.unboundCount).toBe(2)
  expect(p.fetchOperations).not.toHaveBeenCalled()
})

test('период сбора — последние days дней от now', async () => {
  const p = plugin()
  await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a']) }))
  const until = Date.parse('2026-09-29T00:00:00Z')
  expect(p.fetchOperations).toHaveBeenCalledWith(LIVE, 'a', until - 30 * 86_400_000, until)
})

test('банк отказал по одному счёту — у него error, другой собран', async () => {
  // ошибка fetchOperations — отказ счёта, а не всего сбора: иначе один
  // экзотический счёт оставил бы без импорта остальные
  const p = plugin({
    fetchOperations: vi.fn(async (_c: Credentials, id: string) => {
      if (id === 'a') throw new Error('Банк не отдал операции счёта')
      return [operation(`${id}-1`)]
    }),
  })
  const summary = await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a', 'b']) }))
  expect(summary.accounts).toEqual([
    expect.objectContaining({ appAccountId: 'app-a', collected: 0, importId: null, error: 'Банк не отдал операции счёта' }),
    expect.objectContaining({ appAccountId: 'app-b', collected: 1, importId: 'imp-1', error: null }),
  ])
})

test('сессия банка умерла посреди сбора — сбор отвергнут, следующие счета не собирались', async () => {
  // после смерти сессии каждый счёт получил бы тот же отказ, и итог выглядел
  // бы как «не повезло со счетами», а не «нужно войти заново»
  const isAlive = vi.fn<BankPlugin['isAlive']>().mockResolvedValueOnce(true).mockResolvedValue(false)
  const p = plugin({
    isAlive,
    fetchOperations: vi.fn(async () => {
      throw new Error('Банк ответил 403')
    }),
  })
  await expect(collectBank(host({ plugin: p, fetchImpl: await appFetch(['a', 'b']) }))).rejects.toThrow(
    /кончилась посреди сбора/,
  )
  expect(p.fetchOperations).toHaveBeenCalledTimes(1)
})

test('сессия банка умерла посреди сбора — ошибка несёт итоги уже пройденных счетов', async () => {
  // экран должен сказать человеку, что часть работы сделана и лежит в приложении
  const isAlive = vi.fn<BankPlugin['isAlive']>().mockResolvedValueOnce(true).mockResolvedValue(false)
  const p = plugin({
    isAlive,
    fetchOperations: vi.fn(async (_c: Credentials, id: string) => {
      if (id === 'b') throw new Error('Банк ответил 403')
      return [operation(`${id}-1`)]
    }),
  })
  const error = await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a', 'b']) })).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(BankSessionExpiredError)
  expect((error as BankSessionExpiredError).message).toMatch(/кончилась посреди сбора/)
  expect((error as BankSessionExpiredError).partial).toEqual([
    expect.objectContaining({ appAccountId: 'app-a', collected: 1, importId: 'imp-1', error: null }),
  ])
})

test('отказы счетов при живой сессии — частичный успех, живость проверена один раз', async () => {
  const p = plugin({
    fetchOperations: vi.fn(async () => {
      throw new Error('Банк не отдал операции')
    }),
  })
  const summary = await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a', 'b']) }))
  expect(summary.accounts.map((a) => a.error)).toEqual(['Банк не отдал операции', 'Банк не отдал операции'])
  // один раз при подключении и один — на первой ошибке счёта
  expect(p.isAlive).toHaveBeenCalledTimes(2)
})

test('банк недоступен при повторной проверке живости — сбор отвергнут', async () => {
  const isAlive = vi
    .fn<BankPlugin['isAlive']>()
    .mockResolvedValueOnce(true)
    .mockRejectedValue(new Error('Банк недоступен (таймаут)'))
  const p = plugin({
    isAlive,
    fetchOperations: vi.fn(async () => {
      throw new Error('Банк ответил 500')
    }),
  })
  await expect(collectBank(host({ plugin: p, fetchImpl: await appFetch(['a', 'b']) }))).rejects.toThrow(/недоступен/)
  expect(p.fetchOperations).toHaveBeenCalledTimes(1)
})

test('отказ приложения по счёту — живость банка не проверяется', async () => {
  // банк тут ни при чём: отказал наш же бэкенд
  const p = plugin()
  await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a', 'b'], 'app-a') }))
  expect(p.isAlive).toHaveBeenCalledTimes(1)
})

// Пояснение бывает у счёта без остатка — таким счёт и приходит в бою
function withNote(id: string): CollectedAccount {
  return { ...account(id), balance: null, notes: [ACCOUNT_NOTES.creditBalanceMissing] }
}

test('пояснения плагина доходят до итога привязанного счёта — тому же счёту, а не соседу', async () => {
  const p = plugin({ fetchAccounts: vi.fn(async () => [account('a'), withNote('b'), withNote('c')]) })
  const summary = await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a', 'b']) }))
  expect(summary.accounts.map((a) => [a.appAccountId, a.notes])).toEqual([
    ['app-a', []],
    ['app-b', [ACCOUNT_NOTES.creditBalanceMissing]],
  ])
  // счёт c не привязан: его в итоге нет вовсе, а значит, нет и его пояснения
  expect(summary.unboundCount).toBe(1)
})

test('пояснение остаётся и у счёта с отказом: оно о счёте, а не об операциях', async () => {
  const p = plugin({
    fetchAccounts: vi.fn(async () => [withNote('a')]),
    fetchOperations: vi.fn(async () => {
      throw new Error('Банк не отдал операции')
    }),
  })
  const summary = await collectBank(host({ plugin: p, fetchImpl: await appFetch(['a']) }))
  expect(summary.accounts).toEqual([
    expect.objectContaining({ error: 'Банк не отдал операции', notes: [ACCOUNT_NOTES.creditBalanceMissing] }),
  ])
})

test('пояснения в приложение не уезжают — ни со списком счетов, ни с импортом', async () => {
  // они только для экрана: договор API о них не знает
  const p = plugin({ fetchAccounts: vi.fn(async () => [withNote('a')]) })
  const fetchImpl = await appFetch(['a'])
  await collectBank(host({ plugin: p, fetchImpl }))

  const calls = vi.mocked(fetchImpl).mock.calls
  expect(calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/api/accounts/discovered', '/api/imports/parsed'])
  for (const [, init] of calls) {
    const body = String(init?.body)
    expect(body).not.toContain('notes')
    expect(body).not.toContain(ACCOUNT_NOTES.creditBalanceMissing)
  }
})
