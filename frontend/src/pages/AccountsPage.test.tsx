import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { Account } from '../api/ledger'
import { getAccounts, updateAccount } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { AccountsPage } from './AccountsPage'

// Мокаем клиентские функции api/ledger, а не fetch: проверяем, что показывает
// карточка счёта и с чем уходит правка, а не устройство HTTP-запросов.
vi.mock('../api/ledger', () => ({
  getAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
}))

const base: Account = {
  id: 'a1', name: 'Т-Банк', type: 'card', currency: 'RUB', is_archived: false,
  balance: '4900.0000', reported_at: null, card_masks: [],
}

beforeEach(() => {
  useWorkspaceStore.getState().setWorkspaceId('ws-1')
  vi.clearAllMocks()
})

function renderPage(account: Account) {
  vi.mocked(getAccounts).mockResolvedValue([account])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <AccountsPage />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

test('счёт с картами опознаётся по их последним цифрам', async () => {
  renderPage({ ...base, card_masks: ['1234'] })

  expect(await screen.findByText('•• 1234')).toBeDefined()
  // цифры заменяют тип, а не дополняют его: у всех карт банка тип одинаковый,
  // и по нему счета друг от друга не отличить
  expect(screen.queryByText('Карта')).toBeNull()
})

test('счёт без карт подписан своим типом', async () => {
  renderPage({ ...base, name: 'Кошелёк', type: 'cash' })

  expect(await screen.findByText('Наличные')).toBeDefined()
})

test('счёту с остатком от источника правка остатка не предлагается', async () => {
  renderPage({ ...base, card_masks: ['1234'], reported_at: '2026-09-03T10:15:00+03:00' })

  expect(await screen.findByText(/остаток на/)).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Изменить' }))

  // ждём саму форму: содержимое модального окна появляется не в тот же тик,
  // и без ожидания проверка «поля нет» проходила бы всегда
  expect(await screen.findByLabelText('Название')).toBeDefined()
  expect(screen.queryByLabelText('Остаток')).toBeNull()
})

test('счёту без источника остаток правится вручную', async () => {
  renderPage(base)

  await userEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
  await userEvent.type(await screen.findByLabelText('Остаток'), '5100.50')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(updateAccount).toHaveBeenCalledWith('ws-1', 'a1', {
    name: 'Т-Банк', is_archived: undefined, balance: '5100.50',
  })
})

test('отказ бэкенда в правке остатка виден человеку', async () => {
  // между загрузкой страницы и сохранением источник мог сообщить остаток —
  // тогда правка упирается в 409, и кнопка обязана это объяснить
  renderPage(base)
  vi.mocked(updateAccount).mockRejectedValue(
    new ApiError(409, 'Остаток счёта приходит от источника'),
  )

  await userEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
  await userEvent.type(await screen.findByLabelText('Остаток'), '5100.50')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText('Остаток счёта приходит от источника')).toBeDefined()
})
