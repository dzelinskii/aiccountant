import { Button, NumberInput, Select, Stack, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import type { Account, Category } from '../api/ledger'

export interface TransactionFormValues {
  account_id: string
  category_id: string
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
      account_id: '',
      category_id: '',
      amount: '',
      occurred_at: new Date().toISOString().slice(0, 10),
      merchant: '',
      note: '',
    },
    validate: {
      account_id: (v) => (v ? null : 'Выберите счёт'),
      category_id: (v) => (v ? null : 'Выберите категорию'),
      amount: (v) => (Number(v) !== 0 && v !== '' ? null : 'Введите сумму'),
    },
  })

  // знак суммы выводим из kind категории: расход отрицательный, доход положительный
  const submit = (v: typeof form.values) => {
    const kind = categories.find((c) => c.id === v.category_id)?.kind
    const magnitude = Math.abs(Number(v.amount)).toFixed(2)
    const signed = kind === 'expense' ? `-${magnitude}` : magnitude
    onSubmit({ ...v, amount: signed })
  }

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack>
        <Select
          label="Счёт"
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          {...form.getInputProps('account_id')}
        />
        <Select
          label="Категория"
          data={categories.map((c) => ({
            value: c.id,
            label: `${c.name} (${c.kind === 'expense' ? 'расход' : 'доход'})`,
          }))}
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
