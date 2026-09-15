import { expect, test } from 'vitest'
import { parseLossless } from '../../http/lossless-json'
import { toAccounts, toOperations } from './map'

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

test('операция без идентификатора счёта ни в одном из полей — остановка, а не тихий пропуск', () => {
  // isFinancial: true, form не заявочный — банк считает это операцией, но не
  // назвал счёт нигде; это неразобранный ответ, а не «чужая карта»
  const noResource = outcome({ fromResource: undefined, toResource: undefined })
  expect(() => toOperations(parse([noResource]), 'card:1111111111111111')).toThrowError(/счёт/i)
})

test('приход: fromResource есть, но без id — используется toResource', () => {
  const noFromId = income({ fromResource: { displayedValue: 'Какой-то счёт' } })
  const operations = toOperations(parse([noFromId]), 'card:1111111111111111')
  expect(operations).toHaveLength(1)
})

test('перевод между своими картами: оба идентификатора заполнены, операция находится по обеим сторонам', () => {
  const selfTransfer = outcome({
    form: 'UfsTransferSelf',
    fromResource: { id: 'card:1111111111111111' },
    toResource: { id: 'card:2222222222222222' },
  })
  const raw = parse([selfTransfer])
  const bySender = toOperations(raw, 'card:1111111111111111')
  const byReceiver = toOperations(raw, 'card:2222222222222222')
  expect(bySender).toHaveLength(1)
  expect(byReceiver).toHaveLength(1)
  expect(bySender[0]?.kind).toBe('transfer_self')
  expect(byReceiver[0]?.kind).toBe('transfer_self')
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

test('"-0.00" — тоже нулевая сумма, несмотря на знак', () => {
  // "-0.00" собирается прямо в тексте JSON: -0 как JS-литерал сериализуется
  // обратно в "0" через JSON.stringify и потерял бы минус ещё до parseLossless,
  // а проверять нужно именно строку со знаком, как её пришлёт банк
  const raw =
    '[{"uohId":"a1b2c3d4-0000-0000-0000-000000000011","date":"08.09.2026T11:23:45",' +
    '"form":"ExtCardPayment","isFinancial":true,' +
    '"fromResource":{"id":"card:1111111111111111"},' +
    '"operationAmount":{"amount":-0.00,"currencyCode":"RUB"}}]'
  expect(() => toOperations(parseLossless(raw) as unknown[], 'card:1111111111111111')).toThrowError(/нулевая сумма/i)
})

test('финансовая операция без блока суммы — остановка сбора', () => {
  const noAmount = outcome({ operationAmount: undefined })
  expect(() => toOperations(parse([noAmount]), 'card:1111111111111111')).toThrowError(/сумму/i)
})

test('нераспознанная валюта операции — остановка, а не молчаливая подмена на RUB', () => {
  const badCurrency = outcome({ operationAmount: { amount: -10, currencyCode: '810' } })
  expect(() => toOperations(parse([badCurrency]), 'card:1111111111111111')).toThrowError(/валют/i)
})

test('незнакомый вид операции не роняет сбор', () => {
  const strange = outcome({ form: 'СовершенноНовыйВид' })
  expect(toOperations(parse([strange]), 'card:1111111111111111')[0]?.kind).toBe('unknown')
})

test('форма-имя из прототипа не достаёт вид из чужой функции', () => {
  const weird = outcome({ form: 'toString' })
  expect(toOperations(parse([weird]), 'card:1111111111111111')[0]?.kind).toBe('unknown')
})

test('операция в ответе банка пришла не объектом — остановка', () => {
  expect(() => toOperations(parse(['не объект']), 'card:1111111111111111')).toThrowError(/не объектом/i)
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

function debitCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1200010304635762,
    name: 'Дебетовая карта',
    type: 'debit',
    state: 'active',
    number: '2202 20** **** 1234',
    availableLimit: { amount: '1500.55', currency: { code: 'RUB' } },
    ...overrides,
  }
}

function creditCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 3300131089810779,
    name: 'Кредитная карта',
    type: 'credit',
    state: 'active',
    number: '4276 55** **** 9876',
    // доступный лимит включает заёмные деньги — намеренно отличается от
    // остатка, чтобы тест ловил использование не того поля
    availableLimit: { amount: '90000.00', currency: { code: 'RUB' } },
    // поле самой карты (section/meta → cardsInWallet), а не вложенный блок
    // creditType — тот приходит только с отдельной ручки cardInfo, которую
    // коллектор не вызывает
    creditOwnSum: { amount: '250.00', currency: { code: 'RUB' } },
    ...overrides,
  }
}

test('карта превращается в счёт с идентификатором вида card:<id>', () => {
  const [account] = toAccounts(parse([debitCard()]) as Record<string, unknown>[])
  expect(account).toEqual({
    id: 'card:1200010304635762',
    name: 'Дебетовая карта',
    type: 'debit',
    currency: 'RUB',
    balance: '1500.55',
    cardMasks: ['1234'],
  })
})

// Блок creditType, каким его отдаёт cardInfo: долг у карты в обороте велик, а
// собственных средств почти нет — ровно тот случай, на котором прежнее правило
// («остаток равен собственным средствам») показывало почти ноль вместо долга
function creditInfo(debt = '147601.23', own = '250.00'): Map<string, unknown> {
  return new Map([['3300131089810779', { creditOwnSum: { amount: own }, creditDebt: { amount: debt } }]])
}

test('у кредитной карты остаток — чистая позиция: собственные минус долг, при долге минус', () => {
  const [account] = toAccounts(parse([creditCard()]) as Record<string, unknown>[], creditInfo())
  expect(account?.balance).toBe('-147351.23')
})

test('в остаток кредитки не просачивается ни доступный лимит, ни одни собственные средства', () => {
  // сторож против возврата к прежнему поведению: и 250.00 (собственные), и
  // 90000.00 (доступный лимит) — те самые неверные ответы
  const [account] = toAccounts(parse([creditCard()]) as Record<string, unknown>[], creditInfo())
  expect(account?.balance).not.toBe('250.00')
  expect(account?.balance).not.toBe('90000.00')
})

test('тип карты сравнивается регистронезависимо', () => {
  const [account] = toAccounts(parse([creditCard({ type: 'CREDIT' })]) as Record<string, unknown>[], creditInfo())
  expect(account?.balance).toBe('-147351.23')
})

test('долг не пришёл — остаток кредитки null, а не ноль', () => {
  // ноль неотличим от «долга нет», хотя на деле это «банк не сообщил»
  const withoutDebt = new Map([['3300131089810779', { creditOwnSum: { amount: '250.00' } }]])
  expect(toAccounts(parse([creditCard()]) as Record<string, unknown>[], withoutDebt)[0]?.balance).toBeNull()
  expect(toAccounts(parse([creditCard()]) as Record<string, unknown>[])[0]?.balance).toBeNull()
})

test('вычитание идёт без float: разряды не теряются на больших суммах', () => {
  // 99999999999999.99 − 0.01 через Number дало бы 99999999999999.98 неточно;
  // деньги обязаны считаться точно (правило проекта — никакого float)
  const huge = new Map([['3300131089810779', { creditOwnSum: { amount: '99999999999999.99' }, creditDebt: { amount: '0.01' } }]])
  expect(toAccounts(parse([creditCard()]) as Record<string, unknown>[], huge)[0]?.balance).toBe('99999999999999.98')
})

test('разный масштаб долей не ломает вычитание', () => {
  const mixed = new Map([['3300131089810779', { creditOwnSum: { amount: '10' }, creditDebt: { amount: '0.005' } }]])
  expect(toAccounts(parse([creditCard()]) as Record<string, unknown>[], mixed)[0]?.balance).toBe('9.995')
})

test('нулевая разница не превращается в «-0.00»', () => {
  const equal = new Map([['3300131089810779', { creditOwnSum: { amount: '100.00' }, creditDebt: { amount: '100.00' } }]])
  expect(toAccounts(parse([creditCard()]) as Record<string, unknown>[], equal)[0]?.balance).toBe('0.00')
})

test('незнакомый тип карты не подставляет доступный лимит угадыванием — остаток null', () => {
  // creditOwnSum есть у карт обоих типов, поэтому его наличие не различитель;
  // единственный безопасный выбор для непонятного type — не выбирать ничего
  const [account] = toAccounts(parse([creditCard({ type: 'business' })]) as Record<string, unknown>[])
  expect(account?.balance).toBeNull()
})

test('валюта кредитки берётся из availableLimit, даже если creditOwnSum отсутствует', () => {
  const [account] = toAccounts(parse([creditCard({ creditOwnSum: undefined })]) as Record<string, unknown>[])
  expect(account?.balance).toBeNull()
  expect(account?.currency).toBe('RUB')
})

test('шестнадцатизначный идентификатор не теряет точность', () => {
  // id собирается в тексте JSON, а не через объектный литерал: число
  // 9999999999999999 движок JS округлил бы до 10000000000000000 ещё при
  // разборе исходника этого теста, до всякого parseLossless и toAccounts.
  // Тест через объект был бы красным при любой реализации и не проверял бы
  // ничего — тот же урок, что и с суммой выше
  const raw =
    '[{"id":9999999999999999,"name":"Дебетовая карта","type":"debit",' +
    '"number":"2202 20** **** 1234",' +
    '"availableLimit":{"amount":"1500.55","currency":{"code":"RUB"}}}]'
  const [account] = toAccounts(parseLossless(raw) as unknown[])
  expect(account?.id).toBe('card:9999999999999999')
})

test('карта без остатка не роняет список — остаток просто отсутствует', () => {
  const [account] = toAccounts(parse([debitCard({ availableLimit: undefined })]) as Record<string, unknown>[])
  expect(account?.balance).toBeNull()
})

test('карта банка без id — остановка', () => {
  expect(() => toAccounts(parse([debitCard({ id: undefined })]) as Record<string, unknown>[])).toThrowError(/нет id/i)
})
