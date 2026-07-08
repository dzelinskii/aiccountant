import { Button, NumberInput, Select, Stack, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import type { Account } from '../api/ledger'

export interface TransferFormValues {
  from_account_id: string
  to_account_id: string
  from_amount: string
  to_amount: string
  occurred_at: string
  note?: string
}

export function TransferForm({
  accounts,
  onSubmit,
  pending,
}: {
  accounts: Account[]
  onSubmit: (values: TransferFormValues) => void
  pending: boolean
}) {
  const form = useForm({
    initialValues: {
      from_account_id: '',
      to_account_id: '',
      from_amount: '',
      to_amount: '',
      occurred_at: new Date().toISOString().slice(0, 10),
      note: '',
    },
    validate: {
      from_account_id: (v) => (v ? null : 'Выберите счёт списания'),
      to_account_id: (v, values) =>
        !v ? 'Выберите счёт зачисления' : v === values.from_account_id ? 'Счета должны отличаться' : null,
      from_amount: (v) => (Number(v) > 0 ? null : 'Сумма должна быть больше нуля'),
      to_amount: (v) => (Number(v) > 0 ? null : 'Сумма должна быть больше нуля'),
    },
  })

  const submit = (v: typeof form.values) =>
    onSubmit({
      ...v,
      from_amount: Math.abs(Number(v.from_amount)).toFixed(2),
      to_amount: Math.abs(Number(v.to_amount)).toFixed(2),
    })

  const options = accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack>
        <Select label="Со счёта" data={options} {...form.getInputProps('from_account_id')} />
        <NumberInput label="Сумма списания" {...form.getInputProps('from_amount')} />
        <Select label="На счёт" data={options} {...form.getInputProps('to_account_id')} />
        <NumberInput label="Сумма зачисления" {...form.getInputProps('to_amount')} />
        <TextInput label="Дата" type="date" {...form.getInputProps('occurred_at')} />
        <TextInput label="Заметка" {...form.getInputProps('note')} />
        <Button type="submit" loading={pending}>Перевести</Button>
      </Stack>
    </form>
  )
}
