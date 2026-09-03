import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Dashboard } from '../api/ledger'
import { getDashboard } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { DashboardPage } from './DashboardPage'

vi.mock('../api/ledger', () => ({ getDashboard: vi.fn() }))

const account = {
  id: 'a1', name: 'Т-Банк', type: 'card', currency: 'RUB', balance: '4900.0000',
  reported_at: null, card_masks: [] as string[],
}

beforeEach(() => {
  useWorkspaceStore.getState().setWorkspaceId('ws-1')
  vi.clearAllMocks()
})

function renderPage(accounts: Dashboard['accounts']) {
  vi.mocked(getDashboard).mockResolvedValue({ accounts, month_expenses: [], recent: [] })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <DashboardPage />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

test('счёт с картами опознаётся по их последним цифрам', async () => {
  renderPage([{ ...account, card_masks: ['1234'] }])

  expect(await screen.findByText('•• 1234')).toBeDefined()
  expect(screen.queryByText('Карта')).toBeNull()
})

test('счёт без карт подписан своим типом', async () => {
  // метка счёта — правило, а не украшение экрана: список счетов и дашборд
  // обязаны говорить об одном счёте одно и то же
  renderPage([{ ...account, name: 'Кошелёк', type: 'cash' }])

  expect(await screen.findByText('Наличные')).toBeDefined()
})

test('момент показан рядом с остатком от источника', async () => {
  renderPage([{ ...account, reported_at: '2026-09-03T10:15:00+03:00' }])

  expect(await screen.findByText(/остаток на/)).toBeDefined()
})
