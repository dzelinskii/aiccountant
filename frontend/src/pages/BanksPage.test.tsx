import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  AppHttpError,
  BankSessionExpiredError,
  type AccountResult,
  type CollectSummary,
} from 'aiccountant-collector/src/app'
import type { Account } from '../api/ledger'
import { getAccounts, getBanks } from '../api/ledger'
import { collectFromApp, forgetBank } from '../desktop/collector-host'
import { useWorkspaceStore } from '../store/workspace'
import { BanksPage } from './BanksPage'

vi.mock('../api/ledger', () => ({
  getAccounts: vi.fn(),
  getBanks: vi.fn(),
}))
vi.mock('../desktop/collector-host', () => ({
  collectFromApp: vi.fn(),
  forgetBank: vi.fn(),
}))

const account = (id: string, name: string, bankCode: string | null, linked: boolean): Account => ({
  id, name, type: 'card', currency: 'RUB', is_archived: false,
  balance: '0.0000', reported_at: null, card_masks: [], bank_code: bankCode,
  is_bank_linked: linked,
  credit_limit: null, credit_limit_at: null, credit_available: null,
})

const noCounters = { unknownKinds: 0, missingHints: 0, purchases: 0, unrefinedIncome: 0 }

const result = (over: Partial<AccountResult> = {}): AccountResult => ({
  appAccountId: 'a-sber', collected: 3, importId: 'imp-1', counters: noCounters, error: null, ...over,
})

const summary = (over: Partial<CollectSummary> = {}): CollectSummary => ({
  bank: 'sber', session: 'login', accounts: [result()], unboundCount: 0, ...over,
})

const ACCOUNTS = [
  account('a-sber', 'Сбер Мир', 'sber', true),
  account('a-alfa', 'Альфа Дебет', 'alfa', true),
  account('a-tbank', 'Т-Банк Black', 'tbank', false),
]

beforeEach(() => {
  vi.resetAllMocks()
  useWorkspaceStore.getState().setWorkspaceId('ws-1')
})

async function renderPage(accounts: Account[] = ACCOUNTS) {
  vi.mocked(getAccounts).mockResolvedValue(accounts)
  vi.mocked(getBanks).mockResolvedValue([
    { code: 'tbank', name: 'Т-Банк' },
    { code: 'sber', name: 'Сбербанк' },
    { code: 'alfa', name: 'Альфа-Банк' },
    { code: 'vtb', name: 'ВТБ' },
  ])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <BanksPage />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
  await screen.findByTestId('bank-sber')
  // имена счетов приходят отдельным запросом: итог без них подписал бы счёт идентификатором
  await waitFor(() => expect(getAccounts).toHaveBeenCalled())
  return { queryClient, invalidate }
}

const row = (code: string) => within(screen.getByTestId(`bank-${code}`))

test('«Собрать» зовёт сбор своего банка, итог показывает счёт, число, вход и ссылку на импорт', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary())
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(collectFromApp).toHaveBeenCalledWith('sber', 'ws-1')
  expect(await row('sber').findByText(/Сбер Мир/)).toBeDefined()
  expect(row('sber').getByText(/собрано 3/)).toBeDefined()
  expect(row('sber').getByText(/свежий вход/)).toBeDefined()
  expect(row('sber').getByRole('link', { name: /импорт/i }).getAttribute('href')).toBe('/import')
})

test('пока сбор банка идёт, его «Собрать» и «Собрать всё» неактивны, а чужой «Собрать» — нет', async () => {
  let finish: (value: CollectSummary) => void = () => {}
  vi.mocked(collectFromApp).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await renderPage()
  const all = screen.getByRole('button', { name: 'Собрать всё' })
  expect((all as HTMLButtonElement).disabled).toBe(false)

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  await waitFor(() => expect((row('sber').getByRole('button', { name: 'Собрать' }) as HTMLButtonElement).disabled).toBe(true))
  expect((screen.getByRole('button', { name: 'Собрать всё' }) as HTMLButtonElement).disabled).toBe(true)
  expect((row('sber').getByRole('button', { name: 'Забыть доступ' }) as HTMLButtonElement).disabled).toBe(true)
  expect((row('alfa').getByRole('button', { name: 'Собрать' }) as HTMLButtonElement).disabled).toBe(false)

  finish(summary())
  await waitFor(() => expect((row('sber').getByRole('button', { name: 'Собрать' }) as HTMLButtonElement).disabled).toBe(false))
})

test('«Собрать всё» идёт по банкам с привязанным счётом; сбой одного не останавливает остальные', async () => {
  vi.mocked(collectFromApp)
    .mockRejectedValueOnce(new Error('Сбер не отвечает'))
    .mockResolvedValueOnce(summary({ bank: 'alfa', accounts: [result({ appAccountId: 'a-alfa' })] }))
  await renderPage()

  await userEvent.click(screen.getByRole('button', { name: 'Собрать всё' }))

  await waitFor(() => expect(collectFromApp).toHaveBeenCalledTimes(2))
  const banks = vi.mocked(collectFromApp).mock.calls.map((call) => call[0]).sort()
  expect(banks).toEqual(['alfa', 'sber'])
  expect(await screen.findByText(/Сбер не отвечает/)).toBeDefined()
  expect(await row('alfa').findByText(/Альфа Дебет/)).toBeDefined()
})

test('«Собрать всё» неактивна, когда ни у одного банка нет привязанного счёта', async () => {
  await renderPage([account('a-tbank', 'Т-Банк Black', 'tbank', false)])

  expect((screen.getByRole('button', { name: 'Собрать всё' }) as HTMLButtonElement).disabled).toBe(true)
})

test('«Забыть доступ» требует второго нажатия', async () => {
  vi.mocked(forgetBank).mockResolvedValue(undefined)
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Забыть доступ' }))
  expect(forgetBank).not.toHaveBeenCalled()

  await userEvent.click(row('sber').getByRole('button', { name: 'Точно забыть?' }))
  expect(forgetBank).toHaveBeenCalledWith('sber')
})

test('после «Забыть доступ» итог банка исчезает с экрана', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary())
  vi.mocked(forgetBank).mockResolvedValue(undefined)
  await renderPage()
  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))
  await row('sber').findByText(/собрано 3/)

  await userEvent.click(row('sber').getByRole('button', { name: 'Забыть доступ' }))
  await userEvent.click(row('sber').getByRole('button', { name: 'Точно забыть?' }))

  await waitFor(() => expect(row('sber').queryByText(/собрано 3/)).toBeNull())
})

test('банк, у которого нет плагина, строки не получает', async () => {
  await renderPage()

  expect(screen.queryByTestId('bank-vtb')).toBeNull()
  expect(screen.queryByText('ВТБ')).toBeNull()
})

test('отказ приложения 401 сбрасывает кэш «me»: экран входа откроется сам', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new AppHttpError(401, ''))
  const { invalidate } = await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] }))
})

test('иной отказ приложения «me» не трогает', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new AppHttpError(500, ''))
  const { invalidate } = await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  await row('sber').findByText(/Приложение ответило 500/)
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['me'] })
})

test('смерть сессии банка: просьба войти заново и итоги уже созданных импортов', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(
    new BankSessionExpiredError([result({ collected: 5, importId: 'imp-9' })]),
  )
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(/войти заново/)).toBeDefined()
  expect(row('sber').getByText(/собрано 5/)).toBeDefined()
  expect(row('sber').getByText(/ждут решения/)).toBeDefined()
  expect(row('sber').getByRole('link', { name: /импорт/i }).getAttribute('href')).toBe('/import')
})

test('смерть сессии банка без пройденных счетов: только сообщение', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new BankSessionExpiredError([]))
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(/войти заново/)).toBeDefined()
  expect(row('sber').queryByRole('link')).toBeNull()
  expect(row('sber').queryByText(/ждут решения/)).toBeNull()
})

test('после сбора обновляются счета, найденные банком счета и ждущие решения импорты', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary())
  const { invalidate } = await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  await waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pending-imports', 'ws-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['discovered', 'ws-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accounts', 'ws-1'] })
  })
})

test('непривязанные счета банка: сообщение и ссылка на «Счета»', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary({ unboundCount: 2 }))
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(/В банке ещё 2 счёта не ведётся/)).toBeDefined()
  expect(row('sber').getByRole('link', { name: /Счета/ }).getAttribute('href')).toBe('/accounts')
})

test('итог без единого счёта: «Ни один счёт банка не привязан» и ссылка на «Счета»', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary({ accounts: [] }))
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(/Ни один счёт банка не привязан/)).toBeDefined()
  expect(row('sber').getByRole('link', { name: /Счета/ }).getAttribute('href')).toBe('/accounts')
})

test('счёт без операций за период и счёт с ошибкой подписаны по-разному', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(
    summary({
      accounts: [
        result({ importId: null, collected: 0 }),
        result({ appAccountId: 'a-alfa', importId: null, collected: 0, error: 'банк отказал' }),
      ],
    }),
  )
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(/операций за период нет/)).toBeDefined()
  expect(row('sber').getByText(/банк отказал/)).toBeDefined()
  expect(row('sber').queryByRole('link', { name: /импорт/i })).toBeNull()
})

test('счётчики расхождений: ненулевой виден, нулевые молчат', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(
    summary({ accounts: [result({ counters: { ...noCounters, unknownKinds: 4 } })] }),
  )
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(/вид операции не распознан у 4/)).toBeDefined()
  expect(row('sber').queryByText(/категория не определена/)).toBeNull()
  expect(row('sber').queryByText(/приход не разобран/)).toBeNull()
})

test('сбор банка целиком провалился: «Имя банка: текст»', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new Error('Нет входа в приложение'))
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText('Сбербанк: Нет входа в приложение')).toBeDefined()
})
