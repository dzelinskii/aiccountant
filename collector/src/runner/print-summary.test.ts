import { afterEach, expect, test, vi } from 'vitest'
import type { AccountResult, CollectSummary } from '../collect/collect-bank'
import { printSummary } from './print-summary'

afterEach(() => {
  vi.restoreAllMocks()
})

function capture(summary: CollectSummary): string[] {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  printSummary(summary)
  const lines = spy.mock.calls.map((call) => String(call[0]))
  // несколько захватов в одном тесте не должны копить вызовы друг друга
  spy.mockRestore()
  return lines
}

function result(overrides: Partial<AccountResult> = {}): AccountResult {
  return {
    appAccountId: 'app-a',
    collected: 3,
    importId: 'imp-1',
    counters: { unknownKinds: 0, missingHints: 0, purchases: 3, unrefinedIncome: 0 },
    error: null,
    ...overrides,
  }
}

function summary(overrides: Partial<CollectSummary> = {}): CollectSummary {
  return { bank: 'sber', session: 'stored', accounts: [result()], unboundCount: 0, ...overrides }
}

test('по счёту — сколько собрано и номер импорта, а в конце просьба подтвердить импорт', () => {
  const lines = capture(summary())
  expect(lines).toContain('счёт app-a: собрано 3, импорт imp-1')
  expect(lines).toContain('Готово. Подтвердите импорт в приложении.')
})

test('без операций за период — так и сказано, без номера импорта', () => {
  const lines = capture(summary({ accounts: [result({ collected: 0, importId: null })] }))
  expect(lines).toContain('счёт app-a: операций за период нет')
  expect(lines.join('\n')).not.toContain('импорт')
})

test('отказ по счёту печатается строкой счёта, а «Готово» не говорится', () => {
  const lines = capture(summary({ accounts: [result({ collected: 0, importId: null, error: 'Приложение ответило 422' })] }))
  expect(lines).toContain('счёт app-a: Приложение ответило 422')
  expect(lines).not.toContain('Готово. Подтвердите импорт в приложении.')
})

test('счётчики расхождений печатаются все три, с идентификатором счёта', () => {
  // забытый в reportCollected счётчик молчал бы в итоге сбора
  const counters = { unknownKinds: 2, missingHints: 1, purchases: 4, unrefinedIncome: 5 }
  const text = capture(summary({ accounts: [result({ counters })] })).join('\n')
  expect(text).toContain('счёт app-a: вид операции не распознан у 2')
  expect(text).toContain('счёт app-a: категория не определена у 1 трат из 4')
  expect(text).toContain('счёт app-a: приход не разобран у 5')
})

test('источник сессии: из хранилища и свежий вход называются по-разному', () => {
  expect(capture(summary({ session: 'stored' }))[0]).toBe('сессия: из хранилища')
  expect(capture(summary({ session: 'login' }))[0]).toBe('сессия: свежий вход')
})

test('непривязанные счета банка — с правильным склонением', () => {
  expect(capture(summary({ unboundCount: 2 }))).toContain(
    'В банке ещё 2 счёта не ведётся. Привяжите их на экране «Счета».',
  )
})

test('когда все счета привязаны, о непривязанных не говорится', () => {
  expect(capture(summary({ unboundCount: 0 })).join('\n')).not.toContain('В банке ещё')
})

test('ни одного привязанного счёта — подсказка завести счета, без «В банке ещё» и «Готово»', () => {
  const lines = capture(summary({ accounts: [], unboundCount: 2 }))
  expect(lines.join('\n')).toContain('Ни один счёт банка не привязан')
  expect(lines.join('\n')).not.toContain('В банке ещё')
  expect(lines.join('\n')).not.toContain('Готово')
})
