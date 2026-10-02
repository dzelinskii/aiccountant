import { expect, test } from 'vitest'
import type { CollectedOperation } from '../core/contract'
import { accountsWord, countCollected } from './report'

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

test('в счётчик трат без подсказки не попадают переводы', () => {
  // у перевода подсказки нет и быть не может: попади он в счётчик, коллектор
  // на каждом сборе рапортовал бы о дырке в справочнике, которой нет
  const counters = countCollected([
    operation({ external_id: 'op-1', category_hint: null }),
    operation({ external_id: 'op-2', kind: 'transfer_person', category_hint: null }),
    operation({ external_id: 'op-3', kind: 'cash', category_hint: null }),
    operation({ external_id: 'op-4', kind: 'income', category_hint: null }),
    operation({ external_id: 'op-5' }),
  ])

  expect(counters.missingHints).toBe(1)
  expect(counters.purchases).toBe(2)
})

test('когда подсказка есть у всех трат, счётчик равен нулю', () => {
  const counters = countCollected([operation(), operation({ kind: 'transfer_person', category_hint: null })])

  expect(counters.missingHints).toBe(0)
})

test('нераспознанные виды операций считаются по всей пачке', () => {
  const counters = countCollected([
    operation({ kind: 'unknown' }),
    operation({ kind: 'unknown' }),
    operation({ kind: 'purchase' }),
  ])

  expect(counters.unknownKinds).toBe(2)
})

test('счётчик прихода считает только приходы, оставшиеся доходом', () => {
  const counters = countCollected([
    operation({ external_id: 'op-1', kind: 'income' }),
    operation({ external_id: 'op-2', kind: 'income' }),
    operation({ external_id: 'op-3', kind: 'transfer_person' }),
    operation({ external_id: 'op-4' }),
  ])

  expect(counters.unrefinedIncome).toBe(2)
})

test('когда все приходы разобраны, счётчик прихода равен нулю', () => {
  // ноль — нормальное состояние: доходом остаются только те, чью подгруппу мы
  // не знаем, и в обычный день таких нет
  const counters = countCollected([
    operation({ external_id: 'op-1', kind: 'transfer_person' }),
    operation({ external_id: 'op-2', kind: 'cash' }),
  ])

  expect(counters.unrefinedIncome).toBe(0)
})

test('все счётчики считаются одним подсчётом', () => {
  // У не-трат подсказка пустая намеренно: считай счётчик по всем операциям,
  // а не по тратам — и missingHints разъедется
  const counters = countCollected([
    operation({ external_id: 'op-1', kind: 'unknown', category_hint: null }),
    operation({ external_id: 'op-2', category_hint: null }),
    operation({ external_id: 'op-3' }),
    operation({ external_id: 'op-4', kind: 'income', category_hint: null }),
  ])

  expect(counters).toEqual({ unknownKinds: 1, missingHints: 1, purchases: 2, unrefinedIncome: 1 })
})

test('счета склоняются по-русски, включая второй десяток', () => {
  // "11 счёт(ов)" выдаёт машину; исключение на 11-14 — то место, где склонение
  // ломается молча и незаметно
  expect(accountsWord(1)).toBe('1 счёт')
  expect(accountsWord(2)).toBe('2 счёта')
  expect(accountsWord(5)).toBe('5 счетов')
  expect(accountsWord(11)).toBe('11 счетов')
  expect(accountsWord(12)).toBe('12 счетов')
  expect(accountsWord(21)).toBe('21 счёт')
  expect(accountsWord(22)).toBe('22 счёта')
  expect(accountsWord(0)).toBe('0 счетов')
})
