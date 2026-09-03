import type { Account } from '../api/ledger'

export const ACCOUNT_TYPES = [
  { value: 'card', label: 'Карта' },
  { value: 'cash', label: 'Наличные' },
  { value: 'savings', label: 'Накопления' },
]

/** Цифры карт: «•• 1234», несколько — через запятую. Пусто, если карт нет. */
export function cardMasksLabel(masks: string[]): string {
  return masks.map((mask) => `•• ${mask}`).join(', ')
}

/** Чем счёт отличается от соседних: цифры карты, а если карт нет — тип счёта. */
export function accountLabel(account: Pick<Account, 'type' | 'card_masks'>): string {
  return (
    cardMasksLabel(account.card_masks) ||
    (ACCOUNT_TYPES.find((t) => t.value === account.type)?.label ?? account.type)
  )
}

/** Момент остатка человеческим текстом: ISO из ответа читать неудобно. */
export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })
}
