// Суммы с бэка приходят строками (точность Decimal). Number здесь — только для
// отображения через Intl; арифметики над деньгами во float в приложении нет.
export function formatMoney(amount: string, currency: string): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount))
}

// Без знака валюты — для пары чисел одной валюты вроде «доступно / лимит», где
// второй знак подряд только мешает читать
export function formatAmount(amount: string): string {
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(Number(amount))
}

// Долг счёта без знака, если остаток отрицательный, иначе null. Знак снимается
// строкой, без Number: сумма остаётся десятичной строкой, как пришла с бэка.
// Нулевой остаток (даже «-0.0000») долгом не считается.
export function debtAmount(amount: string): string | null {
  if (!amount.startsWith('-') || !/[1-9]/u.test(amount)) return null
  return amount.slice(1)
}
