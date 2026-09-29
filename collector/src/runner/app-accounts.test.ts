import { expect, test, vi } from 'vitest'
import type { FetchImpl } from '../http/allowlist-client'
import type { CollectorConfig } from './config'
import { createAppAccount, fetchAppAccounts, linkAppAccount } from './app-accounts'

const config: CollectorConfig = {
  apiBaseUrl: 'http://localhost:8000',
  apiToken: 'token',
  workspaceId: 'ws-1',
  days: 30,
  bank: 'alfa',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

test('список счетов приложения запрашивается верным методом и путём', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () =>
    jsonResponse([
      { id: 'a1', name: 'Карта', is_bank_linked: true },
      { id: 'a2', name: 'Копилка', is_bank_linked: false },
    ]),
  )

  const accounts = await fetchAppAccounts(config, fetchImpl)

  const [url, init] = fetchImpl.mock.calls[0] ?? []
  expect(init?.method).toBe('GET')
  expect(String(url)).toContain('/api/accounts?')
  expect(String(url)).toContain('workspace_id=ws-1')
  expect(accounts).toEqual([
    { id: 'a1', name: 'Карта', isBankLinked: true },
    { id: 'a2', name: 'Копилка', isBankLinked: false },
  ])
})

test('неожиданный ответ на список счетов не проходит молча', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ не: 'список' }))
  await expect(fetchAppAccounts(config, fetchImpl)).rejects.toThrow(/неожиданный ответ/i)
})

test('заведение счёта уходит POST-ом на /api/accounts, отпечаток в теле есть, сырого идентификатора нет', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () =>
    jsonResponse({ id: 'a2', name: 'Текущий счёт', is_bank_linked: true }, 201),
  )

  const created = await createAppAccount(
    config,
    { name: 'Текущий счёт', type: 'card', currency: 'RUB', bankCode: 'alfa', fingerprint: 'f'.repeat(64) },
    fetchImpl,
  )

  const [url, init] = fetchImpl.mock.calls[0] ?? []
  expect(init?.method).toBe('POST')
  expect(String(url)).toContain('/api/accounts?')
  // ровно договорные поля — лишнего (например, идентификатора счёта в банке) в теле нет
  expect(JSON.parse(String(init?.body))).toEqual({
    name: 'Текущий счёт',
    type: 'card',
    currency: 'RUB',
    bank_code: 'alfa',
    bank_account_fingerprint: 'f'.repeat(64),
  })
  expect(created).toEqual({ id: 'a2', name: 'Текущий счёт', isBankLinked: true })
})

test('привязка существующего счёта уходит на /api/accounts/{id}/link', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () =>
    jsonResponse({ id: 'a1', name: 'Карта', is_bank_linked: true }),
  )

  await linkAppAccount(config, 'a1', { bankCode: 'alfa', fingerprint: 'e'.repeat(64) }, fetchImpl)

  const [url, init] = fetchImpl.mock.calls[0] ?? []
  expect(String(url)).toContain('/api/accounts/a1/link')
  expect(init?.method).toBe('POST')
  expect(JSON.parse(String(init?.body))).toEqual({
    bank_code: 'alfa',
    bank_account_fingerprint: 'e'.repeat(64),
  })
})

test('отказ 409 при повторной привязке долетает понятной ошибкой', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () =>
    jsonResponse({ detail: 'Счёт уже привязан к счёту банка' }, 409),
  )

  await expect(
    linkAppAccount(config, 'a1', { bankCode: 'alfa', fingerprint: 'e'.repeat(64) }, fetchImpl),
  ).rejects.toThrow(/409.*привязан/)
})
