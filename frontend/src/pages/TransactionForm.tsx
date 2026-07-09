import { Button, NumberInput, SegmentedControl, Select, Stack, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import type { Account, Category } from '../api/ledger'

export interface TransactionFormValues {
  account_id: string
  category_id?: string
  amount: string
  occurred_at: string
  merchant?: string
  note?: string
}

export function TransactionForm({
  accounts,
  categories,
  onSubmit,
  pending,
}: {
  accounts: Account[]
  categories: Category[]
  onSubmit: (values: TransactionFormValues) => void
  pending: boolean
}) {
  const form = useForm({
    initialValues: {
      direction: 'expense' as 'expense' | 'income',
      account_id: '',
      category_id: '',
      amount: '',
      occurred_at: new Date().toISOString().slice(0, 10),
      merchant: '',
      note: '',
    },
    validate: {
      account_id: (v) => (v ? null : 'Выберите счёт'),
      amount: (v) => (Number(v) !== 0 && v !== '' ? null : 'Введите сумму'),
    },
  })

  // направление задаёт знак суммы (расход отрицательный); категория опциональна
  const submit = (v: typeof form.values) => {
    const magnitude = Math.abs(Number(v.amount)).toFixed(2)
    const signed = v.direction === 'expense' ? `-${magnitude}` : magnitude
    onSubmit({
      account_id: v.account_id,
      amount: signed,
      occurred_at: v.occurred_at,
      category_id: v.category_id || undefined,
      merchant: v.merchant || undefined,
      note: v.note || undefined,
    })
  }

  // в списке категорий — только соответствующие направлению
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
        <Select
          label="Счёт"
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          {...form.getInputProps('account_id')}
        />
        <Select
          label="Категория (необязательно)"
          clearable
          data={visibleCategories.map((c) => ({ value: c.id, label: c.name }))}
          {...form.getInputProps('category_id')}
        />
        <NumberInput label="Сумма" {...form.getInputProps('amount')} />
        <TextInput label="Дата" type="date" {...form.getInputProps('occurred_at')} />
        <TextInput label="Продавец" {...form.getInputProps('merchant')} />
        <TextInput label="Заметка" {...form.getInputProps('note')} />
        <Button type="submit" loading={pending}>Сохранить</Button>
      </Stack>
    </form>
  )
}
