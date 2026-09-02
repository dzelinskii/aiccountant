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
  operation_kind: 'purchase', spending_override: null, counts_as_spending: true,
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

test('перевод между своими счетами подписан и предлагает считать его тратой', async () => {
  renderPage({ ...base, operation_kind: 'transfer_self', counts_as_spending: false })

  expect(await screen.findByText('Между счетами')).toBeDefined()
  const button = await screen.findByRole('button', { name: 'Считать тратой' })

  await userEvent.click(button)
  expect(setSpendingOverride).toHaveBeenCalledWith('ws-1', 't1', true)
})

test('у обычной покупки кнопка выносит её из расходов', async () => {
  renderPage(base)

  expect(await screen.findByRole('button', { name: 'Не считать тратой' })).toBeDefined()
  // подписью помечают только виды, объясняющие строку; покупка её не получает
  expect(screen.queryByText('Между счетами')).toBeNull()
})
