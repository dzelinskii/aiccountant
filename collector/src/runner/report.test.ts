import { afterEach, expect, test, vi } from 'vitest'
import type { CollectedOperation } from '../plugins/tbank/types'
import {
  reportCollected,
  reportMissingHints,
  reportUnknownKinds,
  reportUnrefinedIncome,
} from './report'

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

test('счётчик называет приходы, оставшиеся доходом', () => {
  const log = captureLog()

  reportUnrefinedIncome('acc-app', [
    operation({ external_id: 'op-1', kind: 'income' }),
    operation({ external_id: 'op-2', kind: 'income' }),
    operation({ external_id: 'op-3', kind: 'transfer_person' }),
    operation({ external_id: 'op-4' }),
  ])

  expect(log.lines()).toEqual([
    'счёт acc-app: приход не разобран у 2 — банк прислал незнакомую подгруппу',
  ])
})

test('счётчик молчит, когда все приходы разобраны', () => {
  // молчание — нормальное состояние: доходом остаются только те, чью подгруппу
  // мы не знаем, и в обычный день таких нет
  const log = captureLog()

  reportUnrefinedIncome('acc-app', [
    operation({ external_id: 'op-1', kind: 'transfer_person' }),
    operation({ external_id: 'op-2', kind: 'cash' }),
  ])

  expect(log.lines()).toEqual([])
})

test('в выводе счётчика нет сумм и описаний', () => {
  const log = captureLog()

  reportUnrefinedIncome('acc-app', [
    operation({
      external_id: 'op-1',
      kind: 'income',
      amount: '9999.99',
      description: 'Зарплата за август',
    }),
  ])

  expect(log.lines().join(' ')).not.toContain('9999')
  expect(log.lines().join(' ')).not.toContain('Зарплата')
})

test('при сборе срабатывают все счётчики, а не часть', () => {
  // проводку счётчиков в main.ts проверить нечем: он запускает сбор при импорте.
  // Забытый вызов там оставлял весь набор зелёным, поэтому вызов сведён сюда —
  // и вот это уже проверяемо. Заведут новый счётчик, забудут добавить в
  // reportCollected — упадёт здесь
  const log = captureLog()

  reportCollected('acc-app', [
    operation({ external_id: 'op-1', kind: 'unknown' }),
    operation({ external_id: 'op-2', category_hint: null }),
    operation({ external_id: 'op-3', kind: 'income' }),
  ])

  const lines = log.lines()
  expect(lines).toHaveLength(3)
  expect(lines.some((line) => line.includes('вид операции не распознан'))).toBe(true)
  expect(lines.some((line) => line.includes('категория не определена'))).toBe(true)
  expect(lines.some((line) => line.includes('приход не разобран'))).toBe(true)
})
