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

test('нечётное число экранированных кавычек не закрывает строку раньше времени', () => {
  // чётное число \" в примере выше можно "угадать" не обрабатывая escape вовсе —
  // здесь ровно одна экранированная кавычка, парность ломается без честной обработки
  const parsed = parseLossless('{"s":"a\\"b","v":5}') as Record<string, string>
  expect(parsed.s).toBe('a"b')
  expect(parsed.v).toBe('5')
})

test('завершающий обратный слэш в строке не путает границу строки', () => {
  const parsed = parseLossless('{"s": "C:\\\\", "v": 7}') as Record<string, string>
  expect(parsed.s).toBe('C:\\')
  expect(parsed.v).toBe('7')
})

test('ведущие нули отклоняются, как и в обычном JSON', () => {
  expect(() => parseLossless('{"a": 01}')).toThrow()
  // сверяемся с эталоном: обычный JSON.parse тоже обязан отвергнуть такой вход
  expect(() => JSON.parse('{"a": 01}')).toThrow()
})

test('число вместо строкового ключа отклоняется, как и в обычном JSON', () => {
  expect(() => parseLossless('{1:2}')).toThrow()
  expect(() => JSON.parse('{1:2}')).toThrow()
})

test('большой платёжный документ разбирается линейно, а не квадратично', () => {
  const operations = Array.from({ length: 12_000 }, (_, i) => `{"id":${i},"amount":-1150.55}`)
  const raw = `{"operations":[${operations.join(',')}]}`
  const start = performance.now()
  parseLossless(raw)
  const elapsedMs = performance.now() - start
  // квадратичная реализация здесь уходила в минуты; линейная — единицы миллисекунд.
  // порог намеренно щедрый, чтобы не ловить дребезг CI, но ловить возврат к O(n^2)
  expect(elapsedMs).toBeLessThan(2000)
})
