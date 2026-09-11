import { expect, test } from 'vitest'
import type { CollectedOperation } from '../../core/contract'
import { parseLossless } from '../../http/lossless-json'
import { toAccounts, toOperations } from './map'

// Входы строим текстом и разбираем через parseLossless — ровно как в бою: числа
// остаются строками, и тест на точность денег ловит любую реализацию через float
function opsFrom(json: string): CollectedOperation[] {
  return toOperations(parseLossless(json) as unknown[])
}

function firstOp(json: string): CollectedOperation {
  const op = opsFrom(json)[0]
  if (!op) throw new Error('фикстура не дала ни одной операции')
  return op
}

const EXPENSE = `[{
  "id": "9999aaaa#aa9999",
  "dateTime": "2026-09-11T03:30:15.219+0300",
  "title": "Кофейня",
  "amount": {"value": 102500, "currency": "RUR", "minorUnits": 100},
  "direction": "EXPENSE",
  "mcc": "5814",
  "category": {"id": "00071", "name": "Кафе"}
}]`

test('расход: знак из direction, RUR→RUB, дата по Москве, external_id', () => {
  expect(firstOp(EXPENSE)).toMatchObject({
    external_id: '9999aaaa#aa9999',
    amount: '-1025.00',
    currency: 'RUB',
    occurred_at: '2026-09-11',
  })
})

test('приход получает вид income и положительную сумму', () => {
  const op = firstOp(`[{
    "id": "i1", "dateTime": "2026-09-10T10:00:13.583+0300", "title": "Зачисление",
    "amount": {"value": 4801609, "currency": "RUR", "minorUnits": 100}, "direction": "INCOME",
    "category": {"id": "50002", "name": "Зарплата"}
  }]`)
  expect(op.amount).toBe('48016.09')
  expect(op.kind).toBe('income')
})

test('сумма считается без потери точности на больших значениях', () => {
  // 9999999999999999 как float округлится до 1e16 — Number(value)/100 дал бы
  // "100000000000000". Строковый сдвиг обязан дать точное значение
  const op = firstOp(`[{
    "id": "big", "dateTime": "2026-09-10T10:00:00.000+0300", "title": "Крупная",
    "amount": {"value": 9999999999999999, "currency": "RUR", "minorUnits": 100}, "direction": "INCOME"
  }]`)
  expect(op.amount).toBe('99999999999999.99')
})

test('маленькая сумма меньше делителя получает ведущий ноль', () => {
  const op = firstOp(`[{
    "id": "small", "dateTime": "2026-09-10T10:00:00.000+0300", "title": "Копейки",
    "amount": {"value": 9, "currency": "RUR", "minorUnits": 100}, "direction": "EXPENSE"
  }]`)
  expect(op.amount).toBe('-0.09')
})

test('перевод себе (me2me) — transfer_self, а обычный card2card — transfer_person', () => {
  const me2me = firstOp(`[{
    "id": "t1", "dateTime": "2026-09-10T11:57:12.913+0300", "title": "Перевод в другой банк",
    "amount": {"value": 4888700, "currency": "RUR", "minorUnits": 100}, "direction": "EXPENSE",
    "category": {"id": "00052", "name": "Переводы"},
    "actions": [{"type":"REPEAT","operationType":"FAST_PAYMENT_SYSTEM_TRANSFER_ME2ME"}]
  }]`)
  expect(me2me.kind).toBe('transfer_self')

  const c2c = firstOp(`[{
    "id": "t2", "dateTime": "2026-09-02T20:17:09.174+0300", "title": "Альфа-карта МИР",
    "amount": {"value": 500000, "currency": "RUR", "minorUnits": 100}, "direction": "EXPENSE",
    "category": {"id": "00052", "name": "Переводы"},
    "actions": [{"type":"REPEAT","operationType":"CARD2CARD_TRANSFER"}]
  }]`)
  expect(c2c.kind).toBe('transfer_person')
})

test('заголовок «Перевод себе…» распознаётся как transfer_self даже без operationType', () => {
  const op = firstOp(`[{
    "id": "t3", "dateTime": "2026-09-10T11:57:12.913+0300", "title": "Перевод себе в другой банк через СБП",
    "amount": {"value": 606500, "currency": "RUR", "minorUnits": 100}, "direction": "EXPENSE",
    "category": {"id": "00052", "name": "Переводы"}
  }]`)
  expect(op.kind).toBe('transfer_self')
})

test('перевод по category без operationType — transfer_person', () => {
  const op = firstOp(`[{
    "id": "t4", "dateTime": "2026-09-09T19:18:19.049+0300", "title": "Анастасия С.",
    "amount": {"value": 500000, "currency": "RUR", "minorUnits": 100}, "direction": "EXPENSE",
    "category": {"id": "00052", "name": "Переводы · Альфа-Банк"}
  }]`)
  expect(op.kind).toBe('transfer_person')
})

test('незнакомая категория и вид → вид по направлению', () => {
  const expense = firstOp(`[{
    "id": "u1", "dateTime": "2026-08-18T12:32:20.673+0300", "title": "Прочее",
    "amount": {"value": 9, "currency": "RUR", "minorUnits": 100}, "direction": "EXPENSE",
    "category": {"id": "00025", "name": "Прочие расходы"}
  }]`)
  expect(expense.kind).toBe('purchase')
})

test('mcc даёт подсказку категории, без mcc — null', () => {
  expect(firstOp(EXPENSE).category_hint).not.toBeNull()
  const noMcc = firstOp(`[{
    "id": "n1", "dateTime": "2026-09-10T10:00:00.000+0300", "title": "Без mcc",
    "amount": {"value": 100, "currency": "RUR", "minorUnits": 100}, "direction": "EXPENSE"
  }]`)
  expect(noMcc.category_hint).toBeNull()
})

test('операция без id / направления / суммы / даты — сбор падает, не молчит', () => {
  expect(() => opsFrom(`[{"dateTime":"2026-09-10T10:00:00.000+0300","amount":{"value":1,"currency":"RUR","minorUnits":100},"direction":"EXPENSE"}]`)).toThrow(/id/)
  expect(() => opsFrom(`[{"id":"x","dateTime":"2026-09-10T10:00:00.000+0300","amount":{"value":1,"currency":"RUR","minorUnits":100},"direction":"HZ"}]`)).toThrow(/направлени/)
  expect(() => opsFrom(`[{"id":"x","dateTime":"2026-09-10T10:00:00.000+0300","direction":"EXPENSE"}]`)).toThrow(/сумм/)
  expect(() => opsFrom(`[{"id":"x","direction":"EXPENSE","amount":{"value":1,"currency":"RUR","minorUnits":100}}]`)).toThrow(/дат/)
})

test('нулевая сумма отвергается — бэкенд её не примет', () => {
  expect(() => opsFrom(`[{"id":"z","dateTime":"2026-09-10T10:00:00.000+0300","title":"Ноль","amount":{"value":0,"currency":"RUR","minorUnits":100},"direction":"EXPENSE"}]`)).toThrow(/нулев/)
})

// --- счета и карты ---

function accountsFrom(accountsJson: string, cardsJson: string) {
  const accounts = (parseLossless(accountsJson) as { accounts: unknown[] }).accounts
  const cards = (parseLossless(cardsJson) as { cards: unknown[] }).cards
  return toAccounts(accounts, cards)
}

const ACCOUNTS = `{"accounts":[
  {"number":"40817810000000002905","description":"Текущий счёт","type":"EE",
   "amount":{"value":42600000,"currency":"RUR","minorUnits":100},
   "total":{"value":42600000,"currency":"RUR","minorUnits":100}},
  {"number":"40817810000000000686","description":"Счёт кредитной карты","type":"EG",
   "amount":{"value":197500,"currency":"RUR","minorUnits":100},
   "total":{"value":-5102500,"currency":"RUR","minorUnits":100}},
  {"number":"30601810000000002618","description":"Брокерский счёт МБ ВР","type":"GK",
   "amount":{"value":76605,"currency":"RUR","minorUnits":100},
   "total":{"value":76605,"currency":"RUR","minorUnits":100}},
  {"number":"30601810000000002618","description":"Брокерский счёт МБ ВР","type":"GK",
   "amount":{"value":0,"currency":"CNY","minorUnits":100},
   "total":{"value":0,"currency":"CNY","minorUnits":100}}
]}`

const CARDS = `{"cards":[
  {"number":"220015******0149","isCredit":false,"account":{"number":"40817810000000002905"}},
  {"number":"220015******8618","isCredit":true,"account":{"number":"40817810000000000686"}},
  {"number":"220015******7342","isCredit":false,"account":{"number":"40817810000000002905"}}
]}`

test('счёт: id = номер, остаток из total, валюта RUB, маски карт по счёту', () => {
  const accounts = accountsFrom(ACCOUNTS, CARDS)
  const current = accounts.find((a) => a.id === '40817810000000002905')
  expect(current).toMatchObject({ id: '40817810000000002905', currency: 'RUB', balance: '426000.00' })
  expect(current?.cardMasks.slice().sort()).toEqual(['0149', '7342'])
})

test('остаток кредитки берётся из total (минус при долге), а не из amount', () => {
  const credit = accountsFrom(ACCOUNTS, CARDS).find((a) => a.id === '40817810000000000686')
  // total = -51025.00 (долг), amount = 1975.00 (доступно к трате). Взяв amount,
  // мы показали бы заёмные деньги как собственные — тест это стережёт
  expect(credit?.balance).toBe('-51025.00')
})

test('брокерские (GK) и мультивалютный дубль номера исключены — id остаются уникальными', () => {
  const accounts = accountsFrom(ACCOUNTS, CARDS)
  expect(accounts.map((a) => a.id)).toEqual(['40817810000000002905', '40817810000000000686'])
  const ids = accounts.map((a) => a.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test('металлический счёт исключён по описанию', () => {
  const accounts = accountsFrom(
    `{"accounts":[{"number":"1","description":"Счёт в драг. металлах","type":"EX","total":{"value":0,"currency":"XAU","minorUnits":100}}]}`,
    `{"cards":[]}`,
  )
  expect(accounts).toHaveLength(0)
})

test('нераспознанная валюта и отсутствующий остаток дают null, а не роняют список', () => {
  const accounts = accountsFrom(
    `{"accounts":[{"number":"5","description":"Странный","type":"EE","total":{"value":100,"currency":"??","minorUnits":100}},{"number":"6","description":"Без остатка","type":"EE"}]}`,
    `{"cards":[]}`,
  )
  expect(accounts.find((a) => a.id === '5')?.currency).toBeNull()
  expect(accounts.find((a) => a.id === '6')?.balance).toBeNull()
})
