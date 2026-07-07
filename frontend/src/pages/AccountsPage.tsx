import { Badge, Button, Card, Group, Modal, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { createAccount, getAccounts, updateAccount, type Account } from '../api/ledger'
import { formatMoney } from '../lib/money'
import { useWorkspaceStore } from '../store/workspace'

const TYPES = [
  { value: 'card', label: 'Карта' },
  { value: 'cash', label: 'Наличные' },
  { value: 'savings', label: 'Накопления' },
]

export function AccountsPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [opened, { open, close }] = useDisclosure(false)
  const [editing, setEditing] = useState<Account | null>(null)

  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })

  const form = useForm({
    initialValues: { name: '', type: 'card', currency: 'RUB' },
    validate: { name: (v) => (v.trim() ? null : 'Введите название') },
  })

  const createMut = useMutation({
    mutationFn: (v: { name: string; type: string; currency: string }) => createAccount(ws, v),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      close()
      form.reset()
    },
  })
  const updateMut = useMutation({
    mutationFn: (v: { id: string; name?: string; is_archived?: boolean }) =>
      updateAccount(ws, v.id, { name: v.name, is_archived: v.is_archived }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      close()
      setEditing(null)
    },
  })

  const openCreate = () => {
    setEditing(null)
    form.setValues({ name: '', type: 'card', currency: 'RUB' })
    open()
  }
  const openEdit = (a: Account) => {
    setEditing(a)
    form.setValues({ name: a.name, type: a.type, currency: a.currency })
    open()
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Счета</Title>
        <Button onClick={openCreate}>Добавить счёт</Button>
      </Group>

      {accounts?.map((a) => (
        <Card key={a.id} withBorder>
          <Group justify="space-between">
            <div>
              <Group gap="xs">
                <Text fw={500}>{a.name}</Text>
                {a.is_archived && <Badge color="gray">в архиве</Badge>}
              </Group>
              <Text c="dimmed" size="sm">{TYPES.find((t) => t.value === a.type)?.label}</Text>
            </div>
            <Group>
              <Text fw={700}>{formatMoney(a.balance, a.currency)}</Text>
              <Button variant="light" size="xs" onClick={() => openEdit(a)}>Изменить</Button>
            </Group>
          </Group>
        </Card>
      ))}

      <Modal opened={opened} onClose={close} title={editing ? 'Счёт' : 'Новый счёт'}>
        <form
          onSubmit={form.onSubmit((v) =>
            editing
              ? updateMut.mutate({ id: editing.id, name: v.name })
              : createMut.mutate(v),
          )}
        >
          <TextInput label="Название" {...form.getInputProps('name')} />
          <Select label="Тип" data={TYPES} mt="sm" disabled={!!editing} {...form.getInputProps('type')} />
          <TextInput label="Валюта" mt="sm" disabled={!!editing} {...form.getInputProps('currency')} />
          {editing && (
            <Switch
              label="В архиве"
              mt="md"
              checked={editing.is_archived}
              onChange={(e) =>
                updateMut.mutate({ id: editing.id, is_archived: e.currentTarget.checked })
              }
            />
          )}
          <Button type="submit" mt="lg" fullWidth loading={createMut.isPending || updateMut.isPending}>
            Сохранить
          </Button>
        </form>
      </Modal>
    </Stack>
  )
}
