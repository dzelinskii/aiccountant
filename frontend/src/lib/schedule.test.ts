import { expect, test } from 'vitest'
import { describeSchedule } from './schedule'

test('месячное правило с якорем', () => {
  const s = describeSchedule('month', 1, 5)
  expect(s).toContain('Каждый месяц')
  expect(s).toContain('5-е')
})

test('интервал больше одного', () => {
  const s = describeSchedule('week', 2, null)
  expect(s).toContain('2')
  expect(s).toContain('нед')
})
