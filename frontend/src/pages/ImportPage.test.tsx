import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { ImportStatus } from '../api/imports'
import { getImportStatus, getPendingImports, rejectImport, startImport } from '../api/imports'
import { useWorkspaceStore } from '../store/workspace'
import { ImportPage } from './ImportPage'

// Логика страницы (поллинг статуса, восстановление после сбоя первого запроса,
// сброс состояния между разборами) не зависит от деталей HTTP — мокаем клиентские
// функции api/imports и api/ledger напрямую, а не fetch. Так тест не завязан на
// multipart/form-data и query-строки, а тайминг поллинга (react-query
// refetchInterval) остаётся настоящим и проверяется по реальному счётчику вызовов.
vi.mock('../api/imports')
vi.mock('../api/ledger', () => ({
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc-1', name: 'Основной счёт', type: 'checking', currency: 'RUB', is_archived: false, balance: '0' },
  ]),
}))

const mockedStartImport = vi.mocked(startImport)
const mockedGetImportStatus = vi.mocked(getImportStatus)
const mockedGetPendingImports = vi.mocked(getPendingImports)
const mockedRejectImport = vi.mocked(rejectImport)

beforeEach(() => {
  useWorkspaceStore.getState().setWorkspaceId('ws-1')
  vi.clearAllMocks()
  mockedStartImport.mockResolvedValue({ import_id: 'imp-1' })
  mockedGetPendingImports.mockResolvedValue([])
})

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <ImportPage />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

// запускает разбор: выбирает счёт, подсовывает файл и жмёт «Разобрать».
// Скрытый <input type="file"> у Mantine FileInput не связан label'ом (htmlFor
// указывает на кнопку-обёртку), поэтому берём его напрямую через container.
async function startParsing() {
  const user = userEvent.setup()
  const { container } = renderPage()

  await user.click(await screen.findByRole('combobox', { name: 'Счёт' }))
  await user.click(await screen.findByText('Основной счёт'))

  const fileInputEl = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['dummy'], 'statement.pdf', { type: 'application/pdf' })
  await user.upload(fileInputEl, file)

  await user.click(screen.getByRole('button', { name: 'Разобрать' }))
}

test(
  'поллинг статуса останавливается, когда разбор готов',
  async () => {
    const processing: ImportStatus = {
      import_id: 'imp-1', status: 'processing', parser: null, error: null, warnings: [], preview: null,
    }
    const ready: ImportStatus = {
      import_id: 'imp-1',
      status: 'ready',
      parser: 'llm',
      error: null,
      warnings: [],
      preview: { operations: [], new_count: 0, duplicate_count: 0, total_income: null, total_expense: null },
    }
    mockedGetImportStatus.mockResolvedValueOnce(processing).mockResolvedValue(ready)

    await startParsing()

    // первый ответ — processing, следующий приходит только через refetchInterval
    // (1500мс в ImportPage), поэтому ждём с запасом
    expect(await screen.findByText(/Новых:/, {}, { timeout: 3000 })).toBeDefined()

    const callsWhenReady = mockedGetImportStatus.mock.calls.length
    // ждём дольше интервала поллинга — если бы поллинг не остановился, счётчик вызовов вырос бы
    await new Promise((resolve) => setTimeout(resolve, 1800))
    expect(mockedGetImportStatus.mock.calls.length).toBe(callsWhenReady)
  },
  10000,
)

test('импорт от коллектора открывается из списка ожидающих', async () => {
  mockedGetPendingImports.mockResolvedValue([
    {
      import_id: 'imp-collector',
      account_id: 'acc-1',
      parser: 'tbank_collector',
      status: 'ready',
      file_name: 'tbank_collector.json',
      created_at: '2026-07-05T10:00:00Z',
      operations_count: 3,
    },
  ])
  mockedGetImportStatus.mockResolvedValue({
    import_id: 'imp-collector',
    status: 'ready',
    parser: 'tbank_collector',
    error: null,
    warnings: [],
    preview: {
      operations: [
        { occurred_at: '2026-07-05', amount: '-1150.0000', currency: 'RUB', description: 'Кофейня', is_duplicate: false },
      ],
      new_count: 1,
      duplicate_count: 0,
      total_income: null,
      total_expense: null,
    },
  })
  const user = userEvent.setup()
  renderPage()

  // файла у такого импорта не было — синтетическое имя не выдаём за имя файла
  expect(await screen.findByText(/Т-Банк, автосбор/)).toBeDefined()
  expect(screen.queryByText(/tbank_collector\.json/)).toBeNull()

  await user.click(screen.getByRole('button', { name: 'Открыть' }))

  expect(await screen.findByText(/Новых:/)).toBeDefined()
  expect(mockedGetImportStatus).toHaveBeenCalledWith('ws-1', 'imp-collector')
})

test('сбой первого запроса статуса не оставляет вечный спиннер', async () => {
  mockedGetImportStatus.mockRejectedValueOnce(new Error('network error'))

  await startParsing()

  expect(await screen.findByText('Не удалось получить статус разбора')).toBeDefined()
  expect(screen.queryByText('Разбираем выписку…')).toBeNull()
})

const COLLECTOR_ITEM = {
  import_id: 'imp-collector',
  account_id: 'acc-1',
  parser: 'tbank_collector',
  status: 'ready' as const,
  file_name: 'tbank_collector.json',
  created_at: '2026-07-05T10:00:00Z',
  operations_count: 3,
}

test('«Отклонить» в списке зовёт ручку и убирает импорт из ожидающих', async () => {
  mockedGetPendingImports.mockResolvedValueOnce([COLLECTOR_ITEM]).mockResolvedValue([])
  mockedRejectImport.mockResolvedValue(undefined)
  const user = userEvent.setup()
  renderPage()

  await user.click(await screen.findByRole('button', { name: 'Отклонить' }))

  expect(mockedRejectImport).toHaveBeenCalledWith('ws-1', 'imp-collector')
  // список перечитан после отклонения — строки больше нет
  await waitFor(() => expect(screen.queryByText(/Т-Банк, автосбор/)).toBeNull())
  expect(mockedGetPendingImports).toHaveBeenCalledTimes(2)
})

test('импорт, который сервер закрыл сам, не пропадает с экрана молча', async () => {
  mockedGetPendingImports.mockResolvedValue([COLLECTOR_ITEM])
  mockedGetImportStatus.mockResolvedValue({
    import_id: 'imp-collector', status: 'completed', parser: 'tbank_collector', error: null, warnings: [], preview: null,
  })
  const user = userEvent.setup()
  renderPage()

  await user.click(await screen.findByRole('button', { name: 'Открыть' }))

  expect(await screen.findByText('Импорт закрыт: все его операции уже в учёте')).toBeDefined()
})

const READY: ImportStatus = {
  import_id: 'imp-1',
  status: 'ready',
  parser: 'llm',
  error: null,
  warnings: [],
  preview: {
    operations: [
      { occurred_at: '2026-07-05', amount: '-1150.0000', currency: 'RUB', description: 'Кофейня', is_duplicate: false },
    ],
    new_count: 1,
    duplicate_count: 0,
    total_income: null,
    total_expense: null,
  },
}

test('«Отклонить» в превью зовёт ручку для открытого импорта', async () => {
  mockedGetImportStatus.mockResolvedValueOnce(READY).mockResolvedValue({ ...READY, status: 'rejected', preview: null })
  mockedRejectImport.mockResolvedValue(undefined)

  await startParsing()
  await userEvent.click(await screen.findByRole('button', { name: 'Отклонить' }))

  expect(mockedRejectImport).toHaveBeenCalledWith('ws-1', 'imp-1')
  // статус перечитан: панель ушла, вместо неё — что стало с импортом
  expect(await screen.findByText('Импорт отклонён, операции не добавлены')).toBeDefined()
  expect(screen.queryByText(/Новых:/)).toBeNull()
})

test('отказ отклонения перечитывает статус: импорт успел закрыться сам', async () => {
  // выписка из одних дублей: опрос увидел ready раньше, чем сервер её закрыл
  mockedGetImportStatus.mockResolvedValueOnce(READY).mockResolvedValue({ ...READY, status: 'completed', preview: null })
  mockedRejectImport.mockRejectedValue(new ApiError(409, 'Импорт уже не ждёт решения'))

  await startParsing()
  await userEvent.click(await screen.findByRole('button', { name: 'Отклонить' }))

  expect(await screen.findByText('Импорт закрыт: все его операции уже в учёте')).toBeDefined()
  expect(screen.getByText('Импорт уже не ждёт решения')).toBeDefined()
})
