import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ImportStatus } from '../api/imports'
import { getImportStatus, getPendingImports, startImport } from '../api/imports'
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
