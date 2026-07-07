import { expect, test } from 'vitest'
import { formatMoney } from './money'

test('форматирует строковую сумму в валюте счёта', () => {
  const s = formatMoney('-500.0000', 'RUB')
  expect(s).toContain('500')
  // Intl отдаёт минус U+2212 или ASCII-дефис в зависимости от сборки ICU
  expect(s).toMatch(/[−-]/)
})

test('ноль форматируется без ошибок', () => {
  expect(formatMoney('0.0000', 'RUB')).toContain('0')
})
