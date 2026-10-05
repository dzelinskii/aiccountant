import { expect, test } from 'vitest'
import { debtFrom, subtractDecimal } from './money'

test('долг из отрицательной суммы — та же сумма', () => {
  expect(debtFrom('-472680.39')).toBe('-472680.39')
})

test('долг из положительной суммы — со знаком минус: у кредита своих денег не бывает', () => {
  expect(debtFrom('50000.00')).toBe('-50000.00')
})

test('нулевой долг — ноль без минуса', () => {
  expect(debtFrom('0.00')).toBe('0.00')
  expect(debtFrom('-0.00')).toBe('0.00')
})

test('не десятичное число — ошибка без значения в тексте', () => {
  expect(() => debtFrom('много')).toThrow(/не десятичное/)
  expect(() => debtFrom('1e5')).toThrow(/не десятичное/)
})

test('разность сумм сохраняет разряды', () => {
  expect(subtractDecimal('139999.53', '142000.00')).toBe('-2000.47')
})
