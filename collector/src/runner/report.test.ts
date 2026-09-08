import { afterEach, expect, test, vi } from 'vitest'
import type { CollectedOperation } from '../plugins/tbank/types'
import { reportMissingHints, reportUnknownKinds } from './report'

function operation(overrides: Partial<CollectedOperation> = {}): CollectedOperation {
  return {
    occurred_at: '2026-07-05',
    amount: '-100.00',
    currency: 'RUB',
    description: 'Тестовая операция',
    external_id: 'op-1',
    kind: 'purchase',
    category_hint: 'groceries',
    ...overrides,
  }
}

// Счётчики пишут в консоль, и проверять их можно только через неё же
function captureLog(): { lines: () => string[] } {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  return { lines: () => spy.mock.calls.map((call) => String(call[0])) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('в счётчик трат без подсказки не попадают переводы', () => {
  // у перевода подсказки нет и быть не может: попади он в счётчик, коллектор
  // на каждом сборе рапортовал бы о дырке в справочнике, которой нет
  const log = captureLog()

  reportMissingHints('acc-app', [
    operation({ external_id: 'op-1', category_hint: null }),
    operation({ external_id: 'op-2', kind: 'transfer_person', category_hint: null }),
    operation({ external_id: 'op-3', kind: 'cash', category_hint: null }),
    operation({ external_id: 'op-4', kind: 'income', category_hint: null }),
    operation({ external_id: 'op-5' }),
  ])

  expect(log.lines()).toEqual(['счёт acc-app: категория не определена у 1 трат из 2'])
})

test('когда подсказка есть у всех трат, счётчик молчит', () => {
  const log = captureLog()

  reportMissingHints('acc-app', [operation(), operation({ kind: 'transfer_person', category_hint: null })])

  expect(log.lines()).toEqual([])
})

test('в счётчике нет сумм и описаний операций', () => {
  // всё, что печатает коллектор, видно в консоли — суммам и описаниям покупок
  // там не место
  const log = captureLog()

  reportMissingHints('acc-app', [operation({ amount: '-4242.42', description: 'Кофейня', category_hint: null })])

  const text = log.lines().join('\n')
  expect(text).not.toContain('4242.42')
  expect(text).not.toContain('Кофейня')
})

test('нераспознанные виды операций считаются по всей пачке', () => {
  const log = captureLog()

  reportUnknownKinds('acc-app', [
    operation({ kind: 'unknown' }),
    operation({ kind: 'unknown' }),
    operation({ kind: 'purchase' }),
  ])

  expect(log.lines()).toEqual([
    'счёт acc-app: вид операции не распознан у 2 — банк прислал незнакомую группу',
  ])
})

test('когда все виды операций распознаны, счётчик молчит', () => {
  const log = captureLog()

  reportUnknownKinds('acc-app', [operation()])

  expect(log.lines()).toEqual([])
})
