import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Transaction } from '../api/ledger'
import {
  applyCategoryToSimilar, getSimilarUncategorized, getTransactions, setSpendingOverride,
  updateTransaction,
} from '../api/ledger'
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
  getSimilarUncategorized: vi.fn(),
  applyCategoryToSimilar: vi.fn(),
}))

const base: Transaction = {
  id: 't1', account_id: 'a1', category_id: null, amount: '-1000.00', currency: 'RUB',
  occurred_at: '2026-09-01', merchant: null, counterparty_name: null, note: null,
  transfer_group_id: null, operation_kind: 'purchase', spending_override: null,
  counts_in_stats: true, category_confirmed: false, suggested_category_id: null,
  category_confidence: null,
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

// Содержимое ячейки под названным заголовком. Искать текст «где-то в строке»
// нельзя: так проходит и вариант с перепутанными местами колонками.
async function cellUnder(header: string) {
  // шапка таблицы отрисована сразу, а строка с данными — только после ответа
  // запроса; без ожидания проверка смотрела бы в пустую таблицу
  const row = await waitFor(() => {
    const rows = screen.getAllByRole('row')
    expect(rows.length).toBeGreaterThan(1) // нулевая — шапка
    return rows[1]
  })
  const headers = screen.getAllByRole('columnheader')
  const column = headers.findIndex((h) => h.textContent === header)
  expect(column).toBeGreaterThan(-1)
  return within(row).getAllByRole('cell')[column]
}

test('в колонке контрагента видно имя, а банковская строка стоит рядом', async () => {
  renderPage({ ...base, merchant: 'ДЕНИС З.', counterparty_name: 'Денис Зелинский' })

  const cell = await cellUnder('Контрагент')
  expect(cell.textContent).toContain('Денис Зелинский')
  // банковскую строку не прячем совсем: по ней и понятно, откуда взялось имя
  expect(cell.textContent).toContain('ДЕНИС З.')
})

test('имя контрагента не занимает чужую колонку', async () => {
  renderPage({ ...base, merchant: 'ДЕНИС З.', counterparty_name: 'Денис Зелинский' })

  const category = await cellUnder('Категория')
  expect(category.textContent).toBe('—')
})

test('без контрагента в колонке остаётся банковская строка', async () => {
  renderPage({ ...base, merchant: 'Пятёрочка', counterparty_name: null })

  // ровно один раз: показывать её и главной строкой, и подписью незачем
  expect((await cellUnder('Контрагент')).textContent).toBe('Пятёрочка')
})

test('операция без описания и без контрагента показывает прочерк', async () => {
  renderPage(base)

  expect((await cellUnder('Контрагент')).textContent).toBe('—')
})

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

// подтверждает подсказанную категорию у операции, на которую похожи ещё count штук
async function confirmCategory(count: number) {
  const suggested: Transaction = { ...base, suggested_category_id: 'c1' }
  vi.mocked(updateTransaction).mockResolvedValue(suggested)
  vi.mocked(getSimilarUncategorized).mockResolvedValue({ count })
  vi.mocked(applyCategoryToSimilar).mockResolvedValue({ applied: count })
  renderPage(suggested)

  await userEvent.click(await screen.findByRole('button', { name: 'Подтвердить категорию' }))
}

test('когда похожих операций нет, вопрос не задаётся', async () => {
  await confirmCategory(0)
  await waitFor(() => expect(getSimilarUncategorized).toHaveBeenCalledWith('ws-1', 't1'))

  // содержимое модального окна Mantine появляется не в тот же такт: сначала
  // дожидаемся заведомо открывающегося окна, иначе проверка «вопроса нет»
  // проходила бы при любом поведении страницы
  await userEvent.click(screen.getByRole('button', { name: 'Добавить расход/доход' }))
  expect(await screen.findByText('Новая операция')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Разложить' })).toBeNull()
})

test('о похожих операциях спрашивают, называя их число', async () => {
  await confirmCategory(5)

  expect(await screen.findByText(/Операций с тем же описанием и без категории: 5/)).toBeDefined()
})

test('согласие раскладывает похожие операции', async () => {
  await confirmCategory(5)

  await userEvent.click(await screen.findByRole('button', { name: 'Разложить' }))

  expect(applyCategoryToSimilar).toHaveBeenCalledWith('ws-1', 't1')
})

test('отказ оставляет уже лежащие операции без категории', async () => {
  // отказ касается только их: правило выучено при подтверждении и отменить
  // его этой кнопкой нельзя
  await confirmCategory(5)

  await userEvent.click(await screen.findByRole('button', { name: 'Не нужно' }))

  expect(applyCategoryToSimilar).not.toHaveBeenCalled()
})
