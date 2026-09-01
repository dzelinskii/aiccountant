import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parseLossless } from '../../http/lossless-json'
import { toAccounts, toOperations } from './map'

// Фикстуры — это то, что реально отдаёт банк по сети: текст. Прогоняем его
// через тот же parseLossless, что и боевой AllowlistClient, — иначе тест
// проверяет не то, с чем на самом деле работает отображение (числа приходят
// строками, а не JS number).
function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../tests/fixtures/${name}`, import.meta.url))
  const text = readFileSync(path, 'utf-8')
  return parseLossless(text)
}

function operationsPayload(): unknown[] {
  const parsed = readFixture('operations.json') as { payload: unknown[] }
  return parsed.payload
}

function accountsPayload(): unknown[] {
  const parsed = readFixture('accounts.json') as { payload: unknown[] }
  return parsed.payload
}

test('расход (Debit) даёт отрицательную сумму', () => {
  const [op1] = toOperations(operationsPayload())
  expect(op1?.amount).toBe('-1150.5')
})

test('приход (Credit) даёт положительную сумму', () => {
  const [, op2] = toOperations(operationsPayload())
  expect(op2?.amount).toBe('5000')
})

test('операции со status !== "OK" не попадают в результат', () => {
  const ops = toOperations(operationsPayload())
  expect(ops).toHaveLength(2)
  expect(ops.some((op) => op.external_id === 'op-3')).toBe(false)
})

test('дата берётся из operationTime, а не debitingTime', () => {
  // в фикстуре op-1 они различаются на сутки: operationTime — 2026-07-06,
  // debitingTime — 2026-07-07. Если бы отображение случайно взяло дату
  // списания, тест поймал бы это как ошибочное 2026-07-07
  const [op1] = toOperations(operationsPayload())
  expect(op1?.occurred_at).toBe('2026-07-06')
})

test('дата ночной операции считается по московскому времени, а не по UTC', () => {
  // 2026-07-15T23:30:00Z — по UTC это ещё 15 июля, но по Москве (UTC+3)
  // уже 2026-07-16T02:30:00. Наивный toISOString().slice(0,10) отдал бы
  // '2026-07-15' — банк в своём приложении покажет '2026-07-16'
  const raw = [
    {
      id: 'op-night',
      status: 'OK',
      type: 'Debit',
      operationTime: { milliseconds: '1784158200000' },
      accountAmount: { value: '100', currency: { strCode: '643' } },
      description: 'Ночная операция',
    },
  ]
  const [op] = toOperations(raw)
  expect(op?.occurred_at).toBe('2026-07-16')
})

test('дата дневной операции совпадает и в UTC, и по Москве (контрольный случай)', () => {
  // 2026-07-15T12:00:00Z = 2026-07-15T15:00:00 по Москве — обе зоны дают
  // один и тот же календарный день, поэтому этот тест не тавтологичен
  // предыдущему: он проверяет, что смещение применяется, а не «сдвигает
  // всё подряд на день»
  const raw = [
    {
      id: 'op-midday',
      status: 'OK',
      type: 'Debit',
      operationTime: { milliseconds: '1784116800000' },
      accountAmount: { value: '100', currency: { strCode: '643' } },
      description: 'Дневная операция',
    },
  ]
  const [op] = toOperations(raw)
  expect(op?.occurred_at).toBe('2026-07-15')
})

test('external_id равен id операции банка', () => {
  const [op1, op2] = toOperations(operationsPayload())
  expect(op1?.external_id).toBe('op-1')
  expect(op2?.external_id).toBe('op-2')
})

test('описание берётся из description', () => {
  const [op1] = toOperations(operationsPayload())
  expect(op1?.description).toBe('Кофейня')
})

test('при пустом description описание берётся из merchant.name', () => {
  const raw = [
    {
      id: 'op-empty-desc',
      status: 'OK',
      type: 'Debit',
      operationTime: { milliseconds: '1783296000000' },
      accountAmount: { value: '100', currency: { strCode: '643' } },
      description: '',
      merchant: { name: 'Магазин' },
    },
  ]
  const [op] = toOperations(raw)
  expect(op?.description).toBe('Магазин')
})

test('сумма не теряет точность', () => {
  const raw = [
    {
      id: 'op-precise',
      status: 'OK',
      type: 'Credit',
      operationTime: { milliseconds: '1783296000000' },
      accountAmount: { value: '12345678901234.5678', currency: { strCode: '643' } },
      description: 'Точная сумма',
    },
  ]
  const [op] = toOperations(raw)
  expect(op?.amount).toBe('12345678901234.5678')
})

test('сумма приходит строкой и результат тоже строка — number в выходе нет', () => {
  const ops = toOperations(operationsPayload())
  for (const op of ops) {
    expect(typeof op.amount).toBe('string')
  }
})

test('toAccounts приводит счета к нашей модели', () => {
  const accounts = toAccounts(accountsPayload())
  expect(accounts).toEqual([
    { id: 'acc-1', name: 'Счёт для трат', type: 'Current', currency: 'RUB' },
    { id: 'acc-2', name: 'Накопительный', type: 'Saving', currency: 'RUB' },
  ])
})
