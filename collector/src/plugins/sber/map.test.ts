import { expect, test } from 'vitest'
import { parseLossless } from '../../http/lossless-json'
import { toOperations } from './map'

// Фикстуры банка приходят текстом, поэтому синтетику тоже прогоняем через
// parseLossless: только так числа станут строками, как в бою
function parse(operations: unknown[]): unknown[] {
  return parseLossless(JSON.stringify(operations)) as unknown[]
}

function outcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uohId: 'a1b2c3d4-0000-0000-0000-000000000001',
    date: '08.09.2026T11:23:45',
    form: 'ExtCardPayment',
    state: { name: 'FINANCIAL', category: 'executed' },
    description: 'Покупка',
    fromResource: { id: 'card:1111111111111111', displayedValue: 'Карта •• 1234' },
    operationAmount: { amount: -123.45, currencyCode: 'RUB' },
    classificationCode: 5411,
    isFinancial: true,
    ...overrides,
  }
}

function income(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uohId: 'a1b2c3d4-0000-0000-0000-000000000002',
    date: '08.09.2026T09:00:00',
    form: 'P2PSBPInTransfer',
    state: { name: 'FINANCIAL', category: 'executed' },
    description: 'Перевод',
    toResource: { id: 'card:1111111111111111', displayedValue: 'Карта •• 1234' },
    operationAmount: { amount: 500, currencyCode: 'RUB' },
    isFinancial: true,
    ...overrides,
  }
}

test('расход разбирается: дата, знак, вид, подсказка категории', () => {
  const [op] = toOperations(parse([outcome()]), 'card:1111111111111111')
  expect(op).toEqual({
    occurred_at: '2026-09-08',
    amount: '-123.45',
    currency: 'RUB',
    description: 'Покупка',
    external_id: 'a1b2c3d4-0000-0000-0000-000000000001',
    kind: 'purchase',
    category_hint: 'groceries',
  })
})

test('classificationCode не из четырёх цифр подсказкой не становится', () => {
  const [op] = toOperations(parse([outcome({ classificationCode: 99997668 })]), 'card:1111111111111111')
  expect(op?.category_hint).toBeNull()
})

test('отсутствие classificationCode — не ошибка', () => {
  const [op] = toOperations(parse([outcome({ classificationCode: undefined })]), 'card:1111111111111111')
  expect(op?.category_hint).toBeNull()
})

test('счёт прихода берётся из toResource, а не из fromResource', () => {
  const operations = toOperations(parse([income()]), 'card:1111111111111111')
  expect(operations).toHaveLength(1)
  expect(operations[0]?.amount).toBe('500')
  expect(operations[0]?.kind).toBe('transfer_person')
})

test('операции чужой карты отфильтровываются', () => {
  expect(toOperations(parse([outcome()]), 'card:9999999999999999')).toHaveLength(0)
})

test('заявка не импортируется', () => {
  const claim = outcome({ form: 'UfsRefinancingClaim', isFinancial: false, operationAmount: undefined })
  expect(toOperations(parse([claim]), 'card:1111111111111111')).toHaveLength(0)
})

test('сумма не проходит через float', () => {
  // 12345678901234.5678 — 18 значащих цифр, за пределами точности double.
  // Если бы фикстура собиралась через JS-число (как в исходной версии этого
  // теста в плане), она потеряла бы разряды ещё на этапе разбора исходника —
  // JSON.stringify(12345678901234.5678) уже даёт "12345678901234.568", и
  // тест был бы красным независимо от корректности toOperations. Поэтому
  // значение amount собирается прямо в тексте JSON, минуя JS number целиком —
  // ровно так, как оно приходит от банка
  const raw =
    '[{"uohId":"a1b2c3d4-0000-0000-0000-000000000009","date":"08.09.2026T11:23:45",' +
    '"form":"ExtCardPayment","isFinancial":true,' +
    '"fromResource":{"id":"card:1111111111111111"},' +
    '"operationAmount":{"amount":12345678901234.5678,"currencyCode":"RUB"}}]'
  const [op] = toOperations(parseLossless(raw) as unknown[], 'card:1111111111111111')
  expect(op?.amount).toBe('12345678901234.5678')
})

test('нулевая сумма — остановка, бэкенд её всё равно не примет', () => {
  const zero = outcome({ operationAmount: { amount: 0, currencyCode: 'RUB' } })
  expect(() => toOperations(parse([zero]), 'card:1111111111111111')).toThrowError(/нулевая сумма/i)
})

test('незнакомый вид операции не роняет сбор', () => {
  const strange = outcome({ form: 'СовершенноНовыйВид' })
  expect(toOperations(parse([strange]), 'card:1111111111111111')[0]?.kind).toBe('unknown')
})

test('пустое описание заменяется контрагентом', () => {
  const empty = outcome({ description: '', correspondent: 'ООО Ромашка' })
  expect(toOperations(parse([empty]), 'card:1111111111111111')[0]?.description).toBe('ООО Ромашка')
})

test('операция без uohId — остановка, дедуп на неё опирается', () => {
  const noId = outcome({ uohId: undefined })
  expect(() => toOperations(parse([noId]), 'card:1111111111111111')).toThrowError(/uohId/)
})

test('непонятная дата — остановка, а не молчаливое сегодня', () => {
  const badDate = outcome({ date: '2026-09-08 11:23:45' })
  expect(() => toOperations(parse([badDate]), 'card:1111111111111111')).toThrowError(/дат/i)
})
