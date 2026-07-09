export type Period = 'day' | 'week' | 'month' | 'year'

const EVERY_ONE: Record<Period, string> = {
  day: 'Каждый день',
  week: 'Каждую неделю',
  month: 'Каждый месяц',
  year: 'Каждый год',
}
// короткие формы, чтобы не мучиться со склонением при interval > 1
const SHORT: Record<Period, string> = { day: 'дн.', week: 'нед.', month: 'мес.', year: 'г.' }

export function describeSchedule(period: Period, interval: number, anchorDay: number | null): string {
  const base = interval === 1 ? EVERY_ONE[period] : `Каждые ${interval} ${SHORT[period]}`
  if (period === 'month' && anchorDay) return `${base}, ${anchorDay}-е`
  return base
}
