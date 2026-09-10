import { Alert, Button, Card, Checkbox, Group, Modal, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  applyCounterpartyCategory, createCounterparty, deleteCounterparty, getCategories,
  getCounterparties, getCounterpartyUncategorized, getUnknownSignatures, updateCounterparty,
  type Counterparty,
} from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'

const KINDS = [
  { value: 'person', label: 'Человек' },
  { value: 'organization', label: 'Организация' },
]

const kindLabel = (kind: string) => KINDS.find((k) => k.value === kind)?.label ?? kind

interface FormValues {
  name: string
  kind: string
  category_id: string
}

export function CounterpartiesPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [opened, { open, close }] = useDisclosure(false)
  const [editing, setEditing] = useState<Counterparty | null>(null)
  // подписи, отмеченные как написания одного и того же контрагента
  const [selected, setSelected] = useState<string[]>([])
  // заведённый контрагент и число накопленных операций без категории
  const [pending, setPending] = useState<{ id: string; count: number } | null>(null)

  const { data: signatures } = useQuery({
    queryKey: ['unknown-signatures', ws],
    queryFn: () => getUnknownSignatures(ws),
  })
  const { data: counterparties } = useQuery({
    queryKey: ['counterparties', ws],
    queryFn: () => getCounterparties(ws),
  })
  const { data: categories } = useQuery({
    queryKey: ['categories', ws],
    queryFn: () => getCategories(ws),
  })

  const form = useForm<FormValues>({
    initialValues: { name: '', kind: 'person', category_id: '' },
    validate: { name: (v) => (v.trim() ? null : 'Введите имя') },
  })

  const invalidate = async () => {
    // заведённая подпись перестаёт быть неопознанной, а удалённый контрагент
    // возвращает свои подписи в этот список — перечитывать надо оба
    await queryClient.invalidateQueries({ queryKey: ['unknown-signatures', ws] })
    await queryClient.invalidateQueries({ queryKey: ['counterparties', ws] })
  }

  const createMut = useMutation({
    mutationFn: (v: FormValues) => createCounterparty(ws, {
      name: v.name,
      kind: v.kind,
      category_id: v.category_id || null,
      signatures: selected,
    }),
    onSuccess: async (created) => {
      // категория контрагента достаётся и уже лежащим операциям, но не молча:
      // спрашиваем, сколько их, и раскладываем только по согласию человека.
      // Контрагенту без категории раскладывать нечего — и спрашивать не о чем.
      // Завелась категория или нет, знает сервер, а не форма: предложение,
      // основанное на форме, пережило бы потерю категории по дороге
      if (created.category_id) {
        const { count } = await getCounterpartyUncategorized(ws, created.id)
        if (count > 0) setPending({ id: created.id, count })
      }
      await invalidate()
      close()
      setSelected([])
      form.reset()
    },
  })

  const updateMut = useMutation({
    mutationFn: (v: { id: string; name: string; category_id: string }) =>
      updateCounterparty(ws, v.id, { name: v.name, category_id: v.category_id || null }),
    onSuccess: async () => {
      await invalidate()
      close()
      setEditing(null)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteCounterparty(ws, id),
    onSuccess: invalidate,
  })

  const applyMut = useMutation({
    mutationFn: (id: string) => applyCounterpartyCategory(ws, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions', ws] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard', ws] })
      setPending(null)
    },
  })

  const toggle = (text: string) =>
    setSelected((s) => (s.includes(text) ? s.filter((t) => t !== text) : [...s, text]))

  // окно одно на заведение и на правку, и Alert в нём рисуется по любой из двух
  // мутаций: не сбросив обе, человек увидел бы в «Новом контрагенте» жалобу на
  // правку, которую только что закрыл
  const forgetErrors = () => {
    createMut.reset()
    updateMut.reset()
  }

  const openCreate = () => {
    setEditing(null)
    forgetErrors()
    form.setValues({ name: '', kind: 'person', category_id: '' })
    open()
  }
  const openEdit = (c: Counterparty) => {
    setEditing(c)
    forgetErrors()
    form.setValues({ name: c.name, kind: c.kind, category_id: c.category_id ?? '' })
    open()
  }

  const submit = (v: FormValues) => {
    if (editing) {
      updateMut.mutate({ id: editing.id, name: v.name, category_id: v.category_id })
      return
    }
    createMut.mutate(v)
  }

  const categoryOptions = (categories ?? []).map((c) => ({ value: c.id, label: c.name }))
  const categoryName = (id: string | null) =>
    id ? (categories?.find((c) => c.id === id)?.name ?? null) : null

  return (
    <Stack>
      <Title order={2}>Контрагенты</Title>

      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Title order={4}>Неопознанные подписи</Title>
          <Button onClick={openCreate}>Завести контрагента</Button>
        </Group>
        <Text c="dimmed" size="sm" mb="sm">
          Отметьте написания одного и того же человека или организации — они
          сойдутся в одного контрагента.
        </Text>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Подпись</Table.Th>
              <Table.Th ta="right">Операций</Table.Th>
              <Table.Th ta="right">Отдано</Table.Th>
              <Table.Th ta="right">Получено</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {signatures?.map((s) => (
              <Table.Tr key={s.text}>
                <Table.Td>
                  <Checkbox
                    label={s.text}
                    checked={selected.includes(s.text)}
                    onChange={() => toggle(s.text)}
                  />
                </Table.Td>
                <Table.Td ta="right">{s.operations}</Table.Td>
                <Table.Td ta="right">{s.sent}</Table.Td>
                <Table.Td ta="right">{s.received}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {signatures?.length === 0 && <Text c="dimmed">Неопознанных подписей нет</Text>}
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">Заведённые</Title>
        <Stack gap="xs">
          {counterparties?.map((c) => (
            <Group key={c.id} justify="space-between">
              <div>
                <Group gap="xs">
                  <Text fw={500}>{c.name}</Text>
                  <Text c="dimmed" size="sm">{kindLabel(c.kind)}</Text>
                  <Text size="sm">{categoryName(c.category_id) ?? 'без категории'}</Text>
                </Group>
                {/* показываем нормализованные ключи: сработает при импорте
                    именно такой, а не исходное написание из банка */}
                <Text c="dimmed" size="xs">{c.signatures.join(', ')}</Text>
              </div>
              {/* имя в aria-label: подписи у всех строк одинаковые, и без него
                  кнопки соседних контрагентов на слух не различить */}
              <Group gap={4}>
                <Button
                  variant="subtle" size="xs"
                  aria-label={`Изменить ${c.name}`}
                  onClick={() => openEdit(c)}
                >
                  Изменить
                </Button>
                <Button
                  variant="subtle" color="red" size="xs"
                  aria-label={`Удалить ${c.name}`}
                  onClick={() => deleteMut.mutate(c.id)}
                >
                  Удалить
                </Button>
              </Group>
            </Group>
          ))}
        </Stack>
        {counterparties?.length === 0 && <Text c="dimmed">Контрагентов пока нет</Text>}
      </Card>

      <Modal opened={opened} onClose={close} title={editing ? 'Контрагент' : 'Новый контрагент'}>
        <form onSubmit={form.onSubmit(submit)}>
          <TextInput label="Имя" {...form.getInputProps('name')} />
          {/* тип правке не подлежит: в PATCH его нет — контрагент заводится
              человеком или организацией и остаётся ею */}
          <Select label="Тип" data={KINDS} mt="sm" disabled={!!editing} {...form.getInputProps('kind')} />
          <Select
            label="Категория"
            mt="sm"
            clearable
            placeholder="без категории"
            data={categoryOptions}
            {...form.getInputProps('category_id')}
          />
          {!editing && (
            <Text c="dimmed" size="sm" mt="sm">
              {selected.length > 0 ? `Подписи: ${selected.join(', ')}` : 'Подписи не отмечены'}
            </Text>
          )}
          {createMut.isError && <Alert color="red" mt="md">{createMut.error.message}</Alert>}
          {updateMut.isError && <Alert color="red" mt="md">{updateMut.error.message}</Alert>}
          <Button type="submit" mt="lg" fullWidth loading={createMut.isPending || updateMut.isPending}>
            Сохранить
          </Button>
        </form>
      </Modal>

      <Modal
        opened={pending !== null}
        onClose={() => setPending(null)}
        title="Разложить накопленные операции?"
      >
        {pending && (
          <Stack>
            <Text>{`Операций этого контрагента без категории: ${pending.count}`}</Text>
            <Text size="sm" c="dimmed">
              Новые операции получат категорию сами. Вопрос только про те, что уже сохранены.
            </Text>
            <Group justify="flex-end">
              <Button variant="subtle" color="gray" onClick={() => setPending(null)}>
                Не нужно
              </Button>
              <Button loading={applyMut.isPending} onClick={() => applyMut.mutate(pending.id)}>
                Разложить
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  )
}
