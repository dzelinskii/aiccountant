import { Button, Group, Modal, Pagination, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  categorizeUncategorized, createTransaction, createTransfer, deleteTransaction, dismissSuggestion,
  getAccounts, getCategories, getTransactions, updateTransaction, type Transaction,
} from '../api/ledger'
import { formatMoney } from '../lib/money'
import { useWorkspaceStore } from '../store/workspace'
import { CategoryCell } from './CategoryCell'
import { TransactionForm, type TransactionFormValues } from './TransactionForm'
import { TransferForm, type TransferFormValues } from './TransferForm'

const PAGE_SIZE = 20

export function TransactionsPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [accountFilter, setAccountFilter] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [txnOpened, txn] = useDisclosure(false)
  const [transferOpened, transfer] = useDisclosure(false)

  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })
  const { data: categories } = useQuery({ queryKey: ['categories', ws], queryFn: () => getCategories(ws) })

  const filters: Record<string, string | number> = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }
  if (accountFilter) filters.account_id = accountFilter
  if (categoryFilter) filters.category_id = categoryFilter
  if (from) filters.from = from
  if (to) filters.to = to

  const { data } = useQuery({
    queryKey: ['transactions', ws, filters],
    queryFn: () => getTransactions(ws, filters),
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['transactions', ws] })
    await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard', ws] })
  }

  const createMut = useMutation({
    mutationFn: (v: TransactionFormValues) => createTransaction(ws, v),
    onSuccess: async () => { await invalidate(); txn.close() },
  })
  const transferMut = useMutation({
    mutationFn: (v: TransferFormValues) => createTransfer(ws, v),
    onSuccess: async () => { await invalidate(); transfer.close() },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteTransaction(ws, id),
    onSuccess: invalidate,
  })
  const confirmMut = useMutation({
    mutationFn: (t: Transaction) =>
      updateTransaction(ws, t.id, { category_id: t.suggested_category_id ?? undefined }),
    onSuccess: invalidate,
  })
  const dismissMut = useMutation({
    mutationFn: (t: Transaction) => dismissSuggestion(ws, t.id),
    onSuccess: invalidate,
  })
  const categorizeMut = useMutation({
    mutationFn: () => categorizeUncategorized(ws),
    onSuccess: invalidate,
  })

  const accountName = (id: string) => accounts?.find((a) => a.id === id)?.name ?? '—'
  const categoryName = (id: string | null) =>
    id ? (categories?.find((c) => c.id === id)?.name ?? '—') : null
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Операции</Title>
        <Group>
          <Button onClick={txn.open}>Добавить расход/доход</Button>
          <Button variant="light" onClick={transfer.open}>Перевод</Button>
          <Button variant="light" loading={categorizeMut.isPending}
            onClick={() => categorizeMut.mutate()}>
            Категоризировать без категории
          </Button>
        </Group>
      </Group>

      <Group>
        <Select
          placeholder="Счёт" clearable
          data={(accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
          value={accountFilter} onChange={(v) => { setAccountFilter(v); setPage(1) }}
        />
        <Select
          placeholder="Категория" clearable
          data={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
          value={categoryFilter} onChange={(v) => { setCategoryFilter(v); setPage(1) }}
        />
        <TextInput type="date" value={from} onChange={(e) => { setFrom(e.currentTarget.value); setPage(1) }} />
        <TextInput type="date" value={to} onChange={(e) => { setTo(e.currentTarget.value); setPage(1) }} />
      </Group>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Дата</Table.Th>
            <Table.Th>Счёт</Table.Th>
            <Table.Th>Категория</Table.Th>
            <Table.Th ta="right">Сумма</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data?.items.map((t) => (
            <Table.Tr key={t.id}>
              <Table.Td>{t.occurred_at}</Table.Td>
              <Table.Td>{accountName(t.account_id)}</Table.Td>
              <Table.Td>
                <CategoryCell
                  txn={t}
                  categoryName={categoryName}
                  onConfirm={(x) => confirmMut.mutate(x)}
                  onDismiss={(x) => dismissMut.mutate(x)}
                />
              </Table.Td>
              <Table.Td ta="right">{formatMoney(t.amount, t.currency)}</Table.Td>
              <Table.Td>
                <Button variant="subtle" color="red" size="xs" onClick={() => deleteMut.mutate(t.id)}>
                  Удалить
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {data && data.total === 0 && <Text c="dimmed">Операций пока нет</Text>}
      <Group justify="center">
        <Pagination total={totalPages} value={page} onChange={setPage} />
      </Group>

      <Modal opened={txnOpened} onClose={txn.close} title="Новая операция">
        <TransactionForm
          accounts={accounts ?? []}
          categories={categories ?? []}
          onSubmit={(v) => createMut.mutate(v)}
          pending={createMut.isPending}
        />
      </Modal>
      <Modal opened={transferOpened} onClose={transfer.close} title="Перевод между счетами">
        <TransferForm
          accounts={accounts ?? []}
          onSubmit={(v) => transferMut.mutate(v)}
          pending={transferMut.isPending}
        />
      </Modal>
    </Stack>
  )
}
