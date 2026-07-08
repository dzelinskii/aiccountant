import { Badge, Button, Card, Group, Modal, NumberInput, Stack, Switch, Table, Text, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getAccounts, getCategories } from '../api/ledger'
import {
  confirmOccurrence, createRule, deleteRule, getOccurrences, getRules, skipOccurrence, updateRule,
  type Occurrence, type RuleInput,
} from '../api/recurring'
import { formatMoney } from '../lib/money'
import { describeSchedule } from '../lib/schedule'
import { useWorkspaceStore } from '../store/workspace'
import { RecurringRuleForm } from './RecurringRuleForm'

export function RecurringPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [formOpened, formModal] = useDisclosure(false)
  const [confirming, setConfirming] = useState<Occurrence | null>(null)
  const [confirmAmount, setConfirmAmount] = useState('')

  const { data: rules } = useQuery({ queryKey: ['recurring', ws], queryFn: () => getRules(ws) })
  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })
  const { data: categories } = useQuery({ queryKey: ['categories', ws], queryFn: () => getCategories(ws) })
  const { data: occurrences } = useQuery({ queryKey: ['occurrences', ws], queryFn: () => getOccurrences(ws) })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['recurring', ws] })
    await queryClient.invalidateQueries({ queryKey: ['occurrences', ws] })
    await queryClient.invalidateQueries({ queryKey: ['transactions', ws] })
    await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard', ws] })
  }

  const createMut = useMutation({ mutationFn: (b: RuleInput) => createRule(ws, b), onSuccess: async () => { await invalidate(); formModal.close() } })
  const toggleMut = useMutation({ mutationFn: (v: { id: string; active: boolean }) => updateRule(ws, v.id, { is_active: v.active }), onSuccess: invalidate })
  const deleteMut = useMutation({ mutationFn: (id: string) => deleteRule(ws, id), onSuccess: invalidate })
  const confirmMut = useMutation({ mutationFn: (v: { id: string; amount: string }) => confirmOccurrence(ws, v.id, v.amount), onSuccess: async () => { await invalidate(); setConfirming(null) } })
  const skipMut = useMutation({ mutationFn: (id: string) => skipOccurrence(ws, id), onSuccess: invalidate })

  const accountName = (id: string) => accounts?.find((a) => a.id === id)?.name ?? '—'
  const categoryName = (id: string) => categories?.find((c) => c.id === id)?.name ?? '—'
  const ruleCurrency = (ruleId: string) => rules?.find((r) => r.id === ruleId)?.currency ?? 'RUB'
  const openConfirm = (o: Occurrence) => { setConfirming(o); setConfirmAmount(o.amount) }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Регулярные платежи</Title>
        <Button onClick={formModal.open}>Добавить правило</Button>
      </Group>

      {occurrences && occurrences.length > 0 && (
        <Card withBorder>
          <Title order={4} mb="sm">К оплате</Title>
          <Stack gap="xs">
            {occurrences.map((o) => (
              <Group key={o.id} justify="space-between">
                <Text size="sm">{o.due_date} · {formatMoney(o.amount, ruleCurrency(o.rule_id))}</Text>
                <Group>
                  <Button size="xs" onClick={() => openConfirm(o)}>Подтвердить</Button>
                  <Button size="xs" variant="subtle" color="gray" onClick={() => skipMut.mutate(o.id)}>Пропустить</Button>
                </Group>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Счёт</Table.Th>
            <Table.Th>Категория</Table.Th>
            <Table.Th>Расписание</Table.Th>
            <Table.Th ta="right">Сумма</Table.Th>
            <Table.Th>Режим</Table.Th>
            <Table.Th>Активно</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rules?.map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{accountName(r.account_id)}</Table.Td>
              <Table.Td>{categoryName(r.category_id)}</Table.Td>
              <Table.Td>{describeSchedule(r.period, r.interval, r.anchor_day)}</Table.Td>
              <Table.Td ta="right">{formatMoney(r.amount, r.currency)}</Table.Td>
              <Table.Td>
                <Badge color={r.mode === 'autopost' ? 'blue' : 'gray'}>
                  {r.mode === 'autopost' ? 'авто' : 'напоминание'}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Switch checked={r.is_active} onChange={(e) => toggleMut.mutate({ id: r.id, active: e.currentTarget.checked })} />
              </Table.Td>
              <Table.Td>
                <Button variant="subtle" color="red" size="xs" onClick={() => deleteMut.mutate(r.id)}>Удалить</Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Modal opened={formOpened} onClose={formModal.close} title="Новое правило">
        <RecurringRuleForm
          accounts={accounts ?? []}
          categories={categories ?? []}
          onSubmit={(b) => createMut.mutate(b)}
          pending={createMut.isPending}
        />
      </Modal>

      <Modal opened={confirming !== null} onClose={() => setConfirming(null)} title="Подтвердить платёж">
        <Stack>
          <NumberInput label="Сумма" value={confirmAmount} onChange={(v) => setConfirmAmount(String(v))} />
          <Button loading={confirmMut.isPending} onClick={() => confirming && confirmMut.mutate({ id: confirming.id, amount: confirmAmount })}>
            Подтвердить
          </Button>
        </Stack>
      </Modal>
    </Stack>
  )
}
