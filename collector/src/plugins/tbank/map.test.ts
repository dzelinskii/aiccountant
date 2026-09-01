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

// Синтетическая операция, которую тесты ниже дополняют своим полем — так
// каждый тест меняет ровно то, что проверяет, а не пересобирает объект целиком
function baseOperation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'op-x',
    status: 'OK',
    type: 'Debit',
    operationTime: { milliseconds: '1783296000000' },
    accountAmount: { value: '100', currency: { strCode: '643' } },
    description: 'Тестовая операция',
    ...overrides,
  }
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
  expect(ops).toHaveLength(3) // op-1, op-2, op-4 — op-3 FAILED отфильтрован
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
  const [op] = toOperations([baseOperation({ operationTime: { milliseconds: '1784158200000' } })])
  expect(op?.occurred_at).toBe('2026-07-16')
})

test('дата дневной операции совпадает и в UTC, и по Москве (контрольный случай)', () => {
  // 2026-07-15T12:00:00Z = 2026-07-15T15:00:00 по Москве — обе зоны дают
  // один и тот же календарный день, поэтому этот тест не тавтологичен
  // предыдущему: он проверяет, что смещение применяется, а не «сдвигает
  // всё подряд на день»
  const [op] = toOperations([baseOperation({ operationTime: { milliseconds: '1784116800000' } })])
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
  const [op] = toOperations([baseOperation({ description: '', merchant: { name: 'Магазин' } })])
  expect(op?.description).toBe('Магазин')
})

test('описание длиннее 1000 символов обрезается локально (бэкенд отверг бы весь запрос)', () => {
  const longDescription = 'x'.repeat(1500)
  const [op] = toOperations([baseOperation({ description: longDescription })])
  expect(op?.description).toHaveLength(1000)
  expect(op?.description).toBe('x'.repeat(1000))
})

test('сумма не теряет точность', () => {
  const [op] = toOperations([
    baseOperation({
      type: 'Credit',
      accountAmount: { value: '12345678901234.5678', currency: { strCode: '643' } },
    }),
  ])
  expect(op?.amount).toBe('12345678901234.5678')
})

test('сумма приходит строкой и результат тоже строка — number в выходе нет', () => {
  const ops = toOperations(operationsPayload())
  for (const op of ops) {
    expect(typeof op.amount).toBe('string')
  }
})

test('сумма, пришедшая уже со знаком, — явная ошибка, а не догадка про двойной минус', () => {
  // "-5" + Debit наивно дал бы "--5" на проводе, а бэкенд ответил бы
  // decimal_parsing и уронил всю пачку операций одной плохой записью
  expect(() => toOperations([baseOperation({ accountAmount: { value: '-5', currency: { strCode: '643' } } })])).toThrow(
    /уже со знаком/,
  )
})

test('текст ошибки про знак не выдаёт саму сумму', () => {
  // сообщения из ядра доходят до консоли, а суммам там не место: искать
  // операцию нужно по идентификатору
  const broken = baseOperation({ id: 'op-77', accountAmount: { value: '-4242.42', currency: { strCode: '643' } } })
  expect(() => toOperations([broken])).toThrow(/op-77/)
  expect(() => toOperations([broken])).not.toThrow(/4242\.42/)
})

test('нулевая сумма — явная ошибка, а не "-0" на проводе', () => {
  expect(() =>
    toOperations([baseOperation({ type: 'Debit', accountAmount: { value: '0', currency: { strCode: '643' } } })]),
  ).toThrow(/нулевая сумма/)
})

test('неизвестный type — явная ошибка, а не молчаливый доход', () => {
  // "Transfer" (или отсутствующий type) не должен молча становиться Credit —
  // иначе расход запишется в леджер как приход
  expect(() => toOperations([baseOperation({ type: 'Transfer' })])).toThrow(/неизвестный тип/)
})

test('операция без id при статусе OK — явная ошибка', () => {
  const withoutId = baseOperation()
  delete withoutId['id']
  expect(() => toOperations([withoutId])).toThrow(/id/)
})

test('операция без operationTime при статусе OK — явная ошибка', () => {
  const withoutTime = baseOperation()
  delete withoutTime['operationTime']
  expect(() => toOperations([withoutTime])).toThrow(/дату/)
})

test('операция с пустой строкой в milliseconds — явная ошибка, а не 1970-01-01', () => {
  // Number('') === 0 — наивная проверка "число или нет" пропустила бы это
  // и молча отдала бы 1970-01-01 вместо явного отказа
  expect(() => toOperations([baseOperation({ operationTime: { milliseconds: '' } })])).toThrow(/дату/)
})

test('операция с нечитаемой датой (вне диапазона Date) — явная ошибка, а не необработанный RangeError', () => {
  expect(() => toOperations([baseOperation({ operationTime: { milliseconds: '1e20' } })])).toThrow(/дату/)
})

test('операция без accountAmount при статусе OK — явная ошибка', () => {
  const withoutAmount = baseOperation()
  delete withoutAmount['accountAmount']
  expect(() => toOperations([withoutAmount])).toThrow(/сумму/)
})

test('операция не объектом (например, массив) в массиве операций — явная ошибка', () => {
  expect(() => toOperations([[]])).toThrow(/не объектом/)
})

test('незнакомый числовой код валюты — явная ошибка, а не подстановка RUB', () => {
  expect(() =>
    toOperations([baseOperation({ accountAmount: { value: '100', currency: { strCode: '840' } } })]),
  ).toThrow(/валют/)
})

test('буквенный код валюты в strCode принимается как есть', () => {
  const [op] = toOperations([baseOperation({ accountAmount: { value: '100', currency: { strCode: 'usd' } } })])
  expect(op?.currency).toBe('USD')
})

test('буквенный код валюты берётся из name, если strCode не распознан', () => {
  const [op] = toOperations([
    baseOperation({ accountAmount: { value: '100', currency: { strCode: '840', name: 'USD' } } }),
  ])
  // важно: strCode здесь numeric и незнакомый (840), но name даёт буквенный код —
  // resolveCurrency обязан проверить оба поля, а не остановиться на первом
  expect(op?.currency).toBe('USD')
})

test('toAccounts приводит счета к нашей модели', () => {
  const accounts = toAccounts(accountsPayload())
  expect(accounts).toEqual([
    { id: 'acc-1', name: 'Счёт для трат', type: 'Current', currency: 'RUB' },
    { id: 'acc-2', name: 'Накопительный', type: 'Saving', currency: 'RUB' },
  ])
})

test('счёт без id — явная ошибка', () => {
  expect(() => toAccounts([{ name: 'Без id', accountType: 'Current', currency: { strCode: '643' } }])).toThrow(/id/)
})

test('счёт с незнакомым числовым кодом валюты — явная ошибка', () => {
  expect(() =>
    toAccounts([{ id: 'acc-x', name: 'Валютный счёт', accountType: 'Current', currency: { strCode: '840' } }]),
  ).toThrow(/валют/)
})
