import { expect, test, vi } from 'vitest'
import { ACCOUNT_NOTES } from '../core/account-notes'
import type { CollectedAccount } from '../core/contract'
import type { FetchImpl } from './app-api'
import type { AppConnection } from './app-connection'
import { syncDiscovered } from './discovered'

const config: AppConnection = {
  baseUrl: 'http://localhost:8000',
  workspaceId: 'ws-1',
  authorization: 'Bearer token',
}

function account(id: string, extra: Partial<CollectedAccount> = {}): CollectedAccount {
  return {
    id,
    name: 'Текущий счёт',
    type: 'CURRENT',
    currency: 'RUB',
    balance: '1000.00',
    creditLimit: null,
    cardMasks: ['1234'],
    notes: [],
    ...extra,
  }
}

function ok(body: unknown): FetchImpl {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as FetchImpl
}

test('в приложение уезжает отпечаток, а не идентификатор счёта', async () => {
  const fetchImpl = ok({ linked: {} })
  await syncDiscovered(config, 'alfa', [account('40817810099910004312')], fetchImpl)

  const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
  const body = JSON.parse(String(init?.body))
  expect(body.accounts[0].fingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(body)).not.toContain('40817810099910004312')
})

test('банковский тип счёта в приложение не отправляется', async () => {
  // CollectedAccount.type — слово банка ('GK' у Альфы, accountType у Т-Банка);
  // словарь банка в ядро не едет
  const fetchImpl = ok({ linked: {} })
  await syncDiscovered(config, 'alfa', [account('acc-1')], fetchImpl)

  const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
  expect(JSON.parse(String(init?.body)).accounts[0]).not.toHaveProperty('type')
})

test('пояснения сбора по счёту в приложение не отправляются', async () => {
  // они живут только в итоге сбора; договор API о них не знает
  const fetchImpl = ok({ linked: {} })
  await syncDiscovered(config, 'alfa', [account('acc-1', { notes: [ACCOUNT_NOTES.creditBalanceMissing] })], fetchImpl)

  const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
  expect(Object.keys(JSON.parse(String(init?.body)).accounts[0]).sort()).toEqual(
    ['balance', 'card_masks', 'currency', 'fingerprint', 'name'],
  )
})

test('привязки возвращаются по идентификатору счёта банка, а не по отпечатку', async () => {
  // дальше по коду ими адресуют fetchOperations, которому нужен id банка
  const { accountFingerprint } = await import('./fingerprint')
  const fingerprint = await accountFingerprint('alfa', 'acc-1')
  const linked = await syncDiscovered(
    config,
    'alfa',
    [account('acc-1'), account('acc-2')],
    ok({ linked: { [fingerprint]: 'app-1' } }),
  )
  expect(linked.get('acc-1')).toBe('app-1')
  expect(linked.has('acc-2')).toBe(false)
})

test('отказ приложения останавливает сбор понятной ошибкой', async () => {
  const fetchImpl = vi.fn(async () => new Response('{"detail":"нет доступа"}', { status: 403 }))
  await expect(
    syncDiscovered(config, 'alfa', [account('acc-1')], fetchImpl as unknown as FetchImpl),
  ).rejects.toThrow(/403/)
})

test('неожиданный ответ не проходит молча', async () => {
  await expect(
    syncDiscovered(config, 'alfa', [account('acc-1')], ok({ что: 'то' })),
  ).rejects.toThrow(/неожиданный ответ/i)
})

test('приложению предъявляется заголовок соединения целиком', async () => {
  const fetchImpl = ok({ linked: {} })
  await syncDiscovered({ ...config, authorization: 'Session abc' }, 'alfa', [account('acc-1')], fetchImpl)

  const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
  const headers = init?.headers as Record<string, string>
  expect(headers['Authorization']).toBe('Session abc')
})
