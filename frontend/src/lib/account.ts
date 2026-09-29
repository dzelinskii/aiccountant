import type { Account, Bank } from '../api/ledger'

export const ACCOUNT_TYPES = [
  { value: 'card', label: 'Карта' },
  { value: 'cash', label: 'Наличные' },
  { value: 'savings', label: 'Накопления' },
]

/**
 * Чем счёт отличается от соседних: цифры карты, а если карт нет — тип счёта.
 *
 * Пустая строка, когда подпись типа повторяет название: счёт «Наличные» типа
 * cash выглядел бы как «Наличные / Наличные». Называть счёт по его типу —
 * самое естественное, что делает человек, и повторение опознать счёт не
 * помогает.
 */
export function accountLabel(account: Pick<Account, 'name' | 'type' | 'card_masks'>): string {
  if (account.card_masks.length > 0) {
    return account.card_masks.map((mask) => `•• ${mask}`).join(', ')
  }
  const label = ACCOUNT_TYPES.find((t) => t.value === account.type)?.label ?? account.type
  return sameText(label, account.name) ? '' : label
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Момент остатка человеческим текстом: ISO из ответа читать неудобно. */
export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })
}

export interface AccountGroup<A extends { bank_code: string | null } = Account> {
  // ключ для React; у группы без банка своего кода нет
  key: string
  title: string
  accounts: A[]
}

const NO_BANK = 'Без банка'

/**
 * Счета по банкам, в порядке первого появления банка в списке.
 *
 * Порядок берётся из самого списка, а не из словаря банков: человек привыкает
 * к своему списку, и добавление банка в словарь не должно переставлять группы.
 * Счёт с незнакомым кодом банка не теряется — его группа называется кодом:
 * потерять счёт с деньгами из-за разъехавшихся версий нельзя.
 *
 * Обобщена по типу счёта: список счетов и дашборд получают от бэкенда счета
 * разной формы (у дашборда нет is_archived), а раскладывать их по банку
 * обязаны одинаково — значит, одной функцией, а не её копией.
 */
export function groupAccountsByBank<A extends { bank_code: string | null }>(
  accounts: A[],
  banks: Bank[],
): AccountGroup<A>[] {
  const names = new Map(banks.map((bank) => [bank.code, bank.name]))
  const groups = new Map<string, AccountGroup<A>>()
  for (const account of accounts) {
    const key = account.bank_code ?? NO_BANK
    const group = groups.get(key)
    if (group) {
      group.accounts.push(account)
      continue
    }
    groups.set(key, {
      key,
      title: account.bank_code === null ? NO_BANK : (names.get(account.bank_code) ?? account.bank_code),
      accounts: [account],
    })
  }
  const ordered = [...groups.values()]
  // наличные есть почти у всех, и первой группой они оттесняли бы банковские
  return ordered.filter((g) => g.key !== NO_BANK).concat(ordered.filter((g) => g.key === NO_BANK))
}
