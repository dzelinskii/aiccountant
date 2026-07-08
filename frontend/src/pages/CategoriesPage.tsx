import { Button, Card, Group, Modal, Select, Stack, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { createCategory, getCategories, updateCategory, type Category } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'

const KINDS = [
  { value: 'expense', label: 'Расход' },
  { value: 'income', label: 'Доход' },
]

export function CategoriesPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [opened, { open, close }] = useDisclosure(false)
  const [editing, setEditing] = useState<Category | null>(null)

  const { data: categories } = useQuery({
    queryKey: ['categories', ws],
    queryFn: () => getCategories(ws),
  })

  const form = useForm({
    initialValues: { name: '', kind: 'expense', parent_id: '' as string },
    validate: { name: (v) => (v.trim() ? null : 'Введите название') },
  })

  const createMut = useMutation({
    mutationFn: (v: { name: string; kind: string; parent_id: string }) =>
      createCategory(ws, { name: v.name, kind: v.kind, parent_id: v.parent_id || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['categories', ws] })
      close()
      form.reset()
    },
  })
  const updateMut = useMutation({
    mutationFn: (v: { id: string; name: string }) => updateCategory(ws, v.id, { name: v.name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['categories', ws] })
      close()
      setEditing(null)
    },
  })

  const parents = (categories ?? []).filter((c) => c.parent_id === null)
  const byKind = (kind: string) => parents.filter((c) => c.kind === kind)
  const children = (id: string) => (categories ?? []).filter((c) => c.parent_id === id)

  const openCreate = () => {
    setEditing(null)
    form.setValues({ name: '', kind: 'expense', parent_id: '' })
    open()
  }
  const openEdit = (c: Category) => {
    setEditing(c)
    form.setValues({ name: c.name, kind: c.kind, parent_id: c.parent_id ?? '' })
    open()
  }

  const renderGroup = (title: string, kind: string) => (
    <Card withBorder>
      <Title order={4} mb="sm">{title}</Title>
      <Stack gap="xs">
        {byKind(kind).map((c) => (
          <div key={c.id}>
            <Group justify="space-between">
              <Text fw={500}>{c.name}</Text>
              <Button variant="subtle" size="xs" onClick={() => openEdit(c)}>Изменить</Button>
            </Group>
            {children(c.id).map((ch) => (
              <Group key={ch.id} justify="space-between" pl="md">
                <Text size="sm" c="dimmed">{ch.name}</Text>
                <Button variant="subtle" size="xs" onClick={() => openEdit(ch)}>Изменить</Button>
              </Group>
            ))}
          </div>
        ))}
      </Stack>
    </Card>
  )

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Категории</Title>
        <Button onClick={openCreate}>Добавить категорию</Button>
      </Group>

      {renderGroup('Расходы', 'expense')}
      {renderGroup('Доходы', 'income')}

      <Modal opened={opened} onClose={close} title={editing ? 'Категория' : 'Новая категория'}>
        <form
          onSubmit={form.onSubmit((v) =>
            editing ? updateMut.mutate({ id: editing.id, name: v.name }) : createMut.mutate(v),
          )}
        >
          <TextInput label="Название" {...form.getInputProps('name')} />
          {!editing && (
            <>
              <Select label="Тип" data={KINDS} mt="sm" {...form.getInputProps('kind')} />
              <Select
                label="Родительская категория"
                mt="sm"
                clearable
                data={byKind(form.values.kind).map((c) => ({ value: c.id, label: c.name }))}
                {...form.getInputProps('parent_id')}
              />
            </>
          )}
          <Button type="submit" mt="lg" fullWidth loading={createMut.isPending || updateMut.isPending}>
            Сохранить
          </Button>
        </form>
      </Modal>
    </Stack>
  )
}
