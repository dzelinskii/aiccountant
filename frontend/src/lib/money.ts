// Суммы с бэка приходят строками (точность Decimal). Number здесь — только для
// отображения через Intl; арифметики над деньгами во float в приложении нет.
export function formatMoney(amount: string, currency: string): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount))
}
