import { expect, test } from 'vitest'
import { parseLossless } from './lossless-json'

test('длинное число не теряет разрядов', () => {
  const raw = '{"amount": {"value": 12345678901234.5678}}'
  const parsed = parseLossless(raw) as { amount: { value: string } }
  // штатный JSON.parse здесь уже потерял бы разряд
  expect(JSON.parse(raw).amount.value.toString()).not.toBe('12345678901234.5678')
  expect(parsed.amount.value).toBe('12345678901234.5678')
})

test('обычные суммы читаются как строки', () => {
  const parsed = parseLossless('{"v": -1150.00}') as { v: string }
  expect(parsed.v).toBe('-1150.00')
})

test('числа в массивах тоже строки', () => {
  const parsed = parseLossless('{"xs": [1, -2.5, 3e2]}') as { xs: string[] }
  expect(parsed.xs).toEqual(['1', '-2.5', '3e2'])
})

test('строки, булевы и null не ломаются', () => {
  const parsed = parseLossless('{"s":"текст","b":true,"n":null}') as Record<string, unknown>
  expect(parsed).toEqual({ s: 'текст', b: true, n: null })
})

test('числа внутри строк не трогаются', () => {
  const parsed = parseLossless('{"s": "цена 1150.00 руб"}') as { s: string }
  expect(parsed.s).toBe('цена 1150.00 руб')
})

test('экранированная кавычка внутри строки не сбивает разбор', () => {
  const parsed = parseLossless('{"s": "он сказал \\"привет\\"", "v": 5}') as Record<string, string>
  expect(parsed.s).toBe('он сказал "привет"')
  expect(parsed.v).toBe('5')
})
