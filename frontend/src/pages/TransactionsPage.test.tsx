import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Transaction } from '../api/ledger'
import { getTransactions, setSpendingOverride } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { TransactionsPage } from './TransactionsPage'

// Мокаем клиентские функции api/ledger, а не fetch: проверяем поведение строки
// таблицы, а не устройство HTTP-запросов.
vi.mock('../api/ledger', () => ({
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'a1', name: 'Карта', type: 'card', currency: 'RUB', is_archived: false, balance: '0' },
  ]),
  getCategories: vi.fn().mockResolvedValue([]),
  getTransactions: vi.fn(),
  createTransaction: vi.fn(),
  createTransfer: vi.fn(),
  deleteTransaction: vi.fn(),
  dismissSuggestion: vi.fn(),
  updateTransaction: vi.fn(),
  categorizeUncategorized: vi.fn(),
  setSpendingOverride: vi.fn(),
}))

const base: Transaction = {
  id: 't1', account_id: 'a1', category_id: null, amount: '-1000.00', currency: 'RUB',
  occurred_at: '2026-09-01', merchant: null, note: null, transfer_group_id: null,
  operation_kind: 'purchase', spending_override: null, counts_in_stats: true,
  category_confirmed: false, suggested_category_id: null, category_confidence: null,
}

beforeEach(() => {
  useWorkspaceStore.getState().setWorkspaceId('ws-1')
  vi.clearAllMocks()
})

function renderPage(txn: Transaction) {
  vi.mocked(getTransactions).mockResolvedValue({ items: [txn], total: 1 })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <TransactionsPage />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

test('перевод между своими счетами подписан и его можно вернуть в статистику', async () => {
  renderPage({ ...base, operation_kind: 'transfer_self', counts_in_stats: false })

  expect(await screen.findByText('Между счетами')).toBeDefined()
  await userEvent.click(await screen.findByRole('button', { name: 'Учитывать в статистике' }))

  expect(setSpendingOverride).toHaveBeenCalledWith('ws-1', 't1', true)
})

test('обычную покупку кнопка выносит из статистики', async () => {
  renderPage(base)

  await userEvent.click(await screen.findByRole('button', { name: 'Не учитывать в статистике' }))

  expect(setSpendingOverride).toHaveBeenCalledWith('ws-1', 't1', false)
  // подписью помечают только виды, объясняющие строку; покупка её не получает
  expect(screen.queryByText('Между счетами')).toBeNull()
})

test('заданное решение можно сбросить обратно к правилу', async () => {
  renderPage({ ...base, spending_override: false, counts_in_stats: false })

  await userEvent.click(await screen.findByRole('button', { name: 'Сбросить решение' }))

  expect(setSpendingOverride).toHaveBeenCalledWith('ws-1', 't1', null)
})

test('строке парного перевода переопределение не предлагается', async () => {
  // бэкенд такую правку отклоняет — кнопки, которая всегда упирается в 409,
  // на экране быть не должно
  renderPage({
    ...base, transfer_group_id: 'g1', operation_kind: 'transfer_self', counts_in_stats: false,
  })

  expect(await screen.findByRole('button', { name: 'Удалить' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Учитывать в статистике' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Сбросить решение' })).toBeNull()
})
