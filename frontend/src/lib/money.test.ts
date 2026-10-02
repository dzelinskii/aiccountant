import { expect, test } from 'vitest'
import { debtAmount, formatMoney } from './money'

test('форматирует строковую сумму в валюте счёта', () => {
  const s = formatMoney('-500.0000', 'RUB')
  expect(s).toContain('500')
  // Intl отдаёт минус U+2212 или ASCII-дефис в зависимости от сборки ICU
  expect(s).toMatch(/[−-]/)
})

test('ноль форматируется без ошибок', () => {
  expect(formatMoney('0.0000', 'RUB')).toContain('0')
})

test('долг — это отрицательная сумма без знака, строкой', () => {
  expect(debtAmount('-2000.4700')).toBe('2000.4700')
  expect(debtAmount('-0.0100')).toBe('0.0100')
})

test('нулевая и положительная суммы долгом не считаются', () => {
  expect(debtAmount('0.0000')).toBeNull()
  expect(debtAmount('-0.0000')).toBeNull()
  expect(debtAmount('500.0000')).toBeNull()
})
