import { Button, NumberInput, SegmentedControl, Select, Stack, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import type { Account, Category } from '../api/ledger'
import type { Mode, Period, RuleInput } from '../api/recurring'

const PERIODS = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'year', label: 'Год' },
]
const MODES = [
  { value: 'autopost', label: 'Проводить автоматически' },
  { value: 'remind', label: 'Напоминать (подтверждаю вручную)' },
]

export function RecurringRuleForm({
  accounts,
  categories,
  onSubmit,
  pending,
}: {
  accounts: Account[]
  categories: Category[]
  onSubmit: (body: RuleInput) => void
  pending: boolean
}) {
  const form = useForm({
    initialValues: {
      direction: 'expense' as 'expense' | 'income',
      account_id: '',
      category_id: '',
      amount: '',
      period: 'month' as Period,
      interval: 1,
      anchor_day: 1,
      start_date: new Date().toISOString().slice(0, 10),
      mode: 'autopost' as Mode,
      end_date: '',
      note: '',
    },
    validate: {
      account_id: (v) => (v ? null : 'Выберите счёт'),
      amount: (v) => (Number(v) !== 0 && v !== '' ? null : 'Введите сумму'),
    },
  })

  // направление задаёт знак суммы; категория опциональна
  const submit = (v: typeof form.values) => {
    const magnitude = Math.abs(Number(v.amount)).toFixed(2)
    const signed = v.direction === 'expense' ? `-${magnitude}` : magnitude
    onSubmit({
      account_id: v.account_id,
      category_id: v.category_id || null,
      amount: signed,
      period: v.period,
      interval: v.interval,
      anchor_day: v.period === 'month' ? v.anchor_day : null,
      start_date: v.start_date,
      mode: v.mode,
      end_date: v.end_date || null,
      note: v.note || null,
    })
  }

  const visibleCategories = categories.filter((c) => c.kind === form.values.direction)

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack>
        <SegmentedControl
          fullWidth
          data={[
            { value: 'expense', label: 'Расход' },
            { value: 'income', label: 'Доход' },
          ]}
          value={form.values.direction}
          onChange={(value) => {
            form.setFieldValue('direction', value as 'expense' | 'income')
            form.setFieldValue('category_id', '')
          }}
        />
        <Select label="Счёт" data={accounts.map((a) => ({ value: a.id, label: a.name }))} {...form.getInputProps('account_id')} />
        <Select
          label="Категория (необязательно)"
          clearable
          data={visibleCategories.map((c) => ({ value: c.id, label: c.name }))}
          {...form.getInputProps('category_id')}
        />
        <NumberInput label="Сумма" {...form.getInputProps('amount')} />
        <Select label="Период" data={PERIODS} {...form.getInputProps('period')} />
        <NumberInput label="Каждые N периодов" min={1} {...form.getInputProps('interval')} />
        {form.values.period === 'month' && (
          <NumberInput label="День месяца" min={1} max={31} {...form.getInputProps('anchor_day')} />
        )}
        <TextInput label="Дата старта" type="date" {...form.getInputProps('start_date')} />
        <Select label="Режим" data={MODES} {...form.getInputProps('mode')} />
        <TextInput label="Дата окончания (необязательно)" type="date" {...form.getInputProps('end_date')} />
        <TextInput label="Заметка" {...form.getInputProps('note')} />
        <Button type="submit" loading={pending}>Сохранить</Button>
      </Stack>
    </form>
  )
}
