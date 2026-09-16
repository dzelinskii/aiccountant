import { expect, test } from 'vitest'
import type { Account, Bank } from '../api/ledger'
import { accountLabel, groupAccountsByBank } from './account'

test('счёт с картами опознаётся по их последним цифрам', () => {
  expect(accountLabel({ name: 'Т-Банк карта', type: 'card', card_masks: ['9358', '1117'] })).toBe(
    '•• 9358, •• 1117',
  )
})

test('счёт без карт опознаётся по типу', () => {
  expect(accountLabel({ name: 'Кошелёк в машине', type: 'cash', card_masks: [] })).toBe('Наличные')
})

test('подпись типа не повторяет название счёта', () => {
  // «Наличные / Наличные» выглядит поломкой, хотя обе части верны по отдельности.
  // Назвать счёт по его типу — самое естественное, что делает человек
  expect(accountLabel({ name: 'Наличные', type: 'cash', card_masks: [] })).toBe('')
})

test('повтор названия распознаётся без учёта регистра и лишних пробелов', () => {
  expect(accountLabel({ name: '  наличные ', type: 'cash', card_masks: [] })).toBe('')
})

test('цифры карты показываются, даже если название совпадает с типом', () => {
  // правило про повтор касается только подписи типа: цифры с названием
  // совпасть не могут
  expect(accountLabel({ name: 'Карта', type: 'card', card_masks: ['1234'] })).toBe('•• 1234')
})

const banks: Bank[] = [
  { code: 'tbank', name: 'Т-Банк' },
  { code: 'sber', name: 'Сбербанк' },
  { code: 'alfa', name: 'Альфа-Банк' },
]

function acc(name: string, bank_code: string | null): Account {
  return {
    id: name,
    name,
    type: 'card',
    currency: 'RUB',
    is_archived: false,
    balance: '0.0000',
    reported_at: null,
    card_masks: [],
    bank_code,
  }
}

test('счета собираются в группы по банку', () => {
  const groups = groupAccountsByBank(
    [acc('Т-карта', 'tbank'), acc('Альфа карта', 'alfa'), acc('Альфа вклад', 'alfa')],
    banks,
  )
  expect(groups.map((g) => g.title)).toEqual(['Т-Банк', 'Альфа-Банк'])
  expect(groups[1]!.accounts.map((a) => a.name)).toEqual(['Альфа карта', 'Альфа вклад'])
})

test('порядок групп повторяет порядок счетов, а не словарь банков', () => {
  // человек привыкает к порядку своего списка; сортировать группы по внешнему
  // списку значит переставлять их при добавлении банка в словарь
  const groups = groupAccountsByBank([acc('Сбер карта', 'sber'), acc('Т-карта', 'tbank')], banks)
  expect(groups.map((g) => g.title)).toEqual(['Сбербанк', 'Т-Банк'])
})

test('счета без банка идут последней группой', () => {
  // наличные есть почти всегда, и первой группой они оттесняли бы банковские
  const groups = groupAccountsByBank([acc('Кошелёк', null), acc('Т-карта', 'tbank')], banks)
  expect(groups.map((g) => g.title)).toEqual(['Т-Банк', 'Без банка'])
})

test('счёт банка, которого нет в словаре, не пропадает из списка', () => {
  // словарь бэкенда и данные могут разъехаться при откате версии; потерять
  // счёт с деньгами из-за этого нельзя
  const groups = groupAccountsByBank([acc('Неизвестный', 'vtb')], banks)
  expect(groups.map((g) => g.title)).toEqual(['vtb'])
})

test('один банк — тоже группа', () => {
  // заголовок при единственном банке не мешает, а исчезающая группировка
  // означала бы два разных экрана вместо одного
  const groups = groupAccountsByBank([acc('Т-карта', 'tbank')], banks)
  expect(groups.map((g) => g.title)).toEqual(['Т-Банк'])
})
