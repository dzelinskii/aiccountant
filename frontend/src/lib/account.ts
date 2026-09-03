import type { Account } from '../api/ledger'

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
