import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Category, Counterparty, UnknownSignature } from '../api/ledger'
import {
  applyCounterpartyCategory, createCounterparty, deleteCounterparty, getCategories,
  getCounterparties, getCounterpartyUncategorized, getUnknownSignatures, updateCounterparty,
} from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { CounterpartiesPage } from './CounterpartiesPage'

// Мокаем функции api/ledger, а не fetch: проверяем, что видно на экране и с чем
// уходит заведение контрагента, а не устройство HTTP-запросов.
vi.mock('../api/ledger', () => ({
  getCounterparties: vi.fn(),
  getUnknownSignatures: vi.fn(),
  getCategories: vi.fn(),
  createCounterparty: vi.fn(),
  updateCounterparty: vi.fn(),
  deleteCounterparty: vi.fn(),
  getCounterpartyUncategorized: vi.fn(),
  applyCounterpartyCategory: vi.fn(),
}))

const category: Category = { id: 'c1', parent_id: null, name: 'Такси', kind: 'expense' }

const denis: Counterparty = {
  id: 'p1', name: 'Денис', kind: 'person', category_id: 'c1',
  signatures: ['денис з.', 'зелинский денис'],
}

const signature: UnknownSignature = {
  text: 'денис з.', operations: 7, sent: 5, received: 2,
}

beforeEach(() => {
  useWorkspaceStore.getState().setWorkspaceId('ws-1')
  vi.clearAllMocks()
})

function renderPage(
  { signatures = [] as UnknownSignature[], counterparties = [] as Counterparty[] } = {},
) {
  vi.mocked(getUnknownSignatures).mockResolvedValue(signatures)
  vi.mocked(getCounterparties).mockResolvedValue(counterparties)
  vi.mocked(getCategories).mockResolvedValue([category])
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <CounterpartiesPage />
      </QueryClientProvider>
    </MantineProvider>,
  )
  return queryClient
}

test('неопознанная подпись показана со своими счётчиками', async () => {
  renderPage({ signatures: [signature] })

  const row = (await screen.findByText('денис з.')).closest('tr')!
  // счётчики сверяем по колонкам, а не по наличию: по одному «7» человек не
  // поймёт, чаще он отдаёт или получает, а перепутанные местами «отдано» и
  // «получено» переворачивают смысл, оставляя те же числа на экране
  const cells = within(row).getAllByRole('cell').map((c) => c.textContent)
  expect(cells).toEqual(['денис з.', '7', '5', '2'])
})

test('заведение отправляет отмеченные подписи', async () => {
  renderPage({
    signatures: [
      signature,
      { text: 'зелинский денис', operations: 3, sent: 3, received: 0 },
      { text: 'мария к.', operations: 1, sent: 1, received: 0 },
    ],
  })
  vi.mocked(createCounterparty).mockResolvedValue(denis)
  vi.mocked(getCounterpartyUncategorized).mockResolvedValue({ count: 0 })

  await userEvent.click(await screen.findByRole('checkbox', { name: 'денис з.' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'зелинский денис' }))
  await userEvent.click(screen.getByRole('button', { name: 'Завести контрагента' }))

  await userEvent.type(await screen.findByLabelText('Имя'), 'Денис')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  // уходят ровно отмеченные подписи: третья осталась неотмеченной и в чужого
  // контрагента попасть не должна
  expect(createCounterparty).toHaveBeenCalledWith('ws-1', {
    name: 'Денис', kind: 'person', category_id: null, signatures: ['денис з.', 'зелинский денис'],
  })
})

test('тип контрагента уходит тот, что выбрали', async () => {
  renderPage({ signatures: [signature] })
  vi.mocked(createCounterparty).mockResolvedValue({ ...denis, kind: 'organization' })
  vi.mocked(getCounterpartyUncategorized).mockResolvedValue({ count: 0 })

  await userEvent.click(await screen.findByRole('checkbox', { name: 'денис з.' }))
  await userEvent.click(screen.getByRole('button', { name: 'Завести контрагента' }))
  await userEvent.type(await screen.findByLabelText('Имя'), 'Яндекс Такси')
  // именно combobox: подпись Select делят поле ввода и список вариантов
  await userEvent.click(screen.getByRole('combobox', { name: 'Тип' }))
  await userEvent.click(await screen.findByText('Организация'))
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(createCounterparty).toHaveBeenCalledWith('ws-1', expect.objectContaining({
    kind: 'organization',
  }))
})

test('после заведения с категорией предлагается разложить накопленное', async () => {
  renderPage({ signatures: [signature] })
  vi.mocked(createCounterparty).mockResolvedValue(denis)
  vi.mocked(getCounterpartyUncategorized).mockResolvedValue({ count: 4 })
  vi.mocked(applyCounterpartyCategory).mockResolvedValue({ applied: 4 })

  await userEvent.click(await screen.findByRole('checkbox', { name: 'денис з.' }))
  await userEvent.click(screen.getByRole('button', { name: 'Завести контрагента' }))
  await userEvent.type(await screen.findByLabelText('Имя'), 'Денис')
  await userEvent.click(screen.getByRole('combobox', { name: 'Категория' }))
  await userEvent.click(await screen.findByText('Такси'))
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText(/без категории: 4/)).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Разложить' }))
  expect(applyCounterpartyCategory).toHaveBeenCalledWith('ws-1', 'p1')
})

test('без накопленных операций разложить не предлагают', async () => {
  // ноль — вопрос без содержания: раскладывать нечего
  renderPage({ signatures: [signature] })
  vi.mocked(createCounterparty).mockResolvedValue(denis)
  vi.mocked(getCounterpartyUncategorized).mockResolvedValue({ count: 0 })

  await userEvent.click(await screen.findByRole('checkbox', { name: 'денис з.' }))
  await userEvent.click(screen.getByRole('button', { name: 'Завести контрагента' }))
  await userEvent.type(await screen.findByLabelText('Имя'), 'Денис')
  await userEvent.click(screen.getByRole('combobox', { name: 'Категория' }))
  await userEvent.click(await screen.findByText('Такси'))
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  // ждём закрытия формы: счётчик спрашивают до него, так что к этому моменту
  // решение о предложении уже принято. Без ожидания проверка «предложения нет»
  // проходила бы и до того, как ответ вообще пришёл
  await vi.waitFor(() => expect(screen.queryByText('Новый контрагент')).toBeNull())
  expect(screen.queryByRole('button', { name: 'Разложить' })).toBeNull()
})

test('контрагента без категории про накопленное не спрашивают', async () => {
  // раскладывать нечего по определению: категории, которую можно проставить, нет
  renderPage({ signatures: [signature] })
  vi.mocked(createCounterparty).mockResolvedValue({ ...denis, category_id: null })

  await userEvent.click(await screen.findByRole('checkbox', { name: 'денис з.' }))
  await userEvent.click(screen.getByRole('button', { name: 'Завести контрагента' }))
  await userEvent.type(await screen.findByLabelText('Имя'), 'Денис')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await vi.waitFor(() => expect(screen.queryByText('Новый контрагент')).toBeNull())
  expect(getCounterpartyUncategorized).not.toHaveBeenCalled()
})

test('заведение обновляет список подписей', async () => {
  // заведённая подпись перестала быть неопознанной — список обязан перечитаться,
  // иначе человек заведёт по ней второго контрагента и упрётся в 409
  const queryClient = renderPage({ signatures: [signature] })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  vi.mocked(createCounterparty).mockResolvedValue(denis)
  vi.mocked(getCounterpartyUncategorized).mockResolvedValue({ count: 0 })

  await userEvent.click(await screen.findByRole('checkbox', { name: 'денис з.' }))
  await userEvent.click(screen.getByRole('button', { name: 'Завести контрагента' }))
  await userEvent.type(await screen.findByLabelText('Имя'), 'Денис')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await vi.waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['unknown-signatures', 'ws-1'] }),
  )
})

test('контрагент показан с типом, категорией и своими подписями', async () => {
  renderPage({ counterparties: [denis] })

  expect(await screen.findByText('Денис')).toBeDefined()
  expect(screen.getByText('Человек')).toBeDefined()
  expect(screen.getByText('Такси')).toBeDefined()
  expect(screen.getByText('денис з., зелинский денис')).toBeDefined()
})

test('правка уносит и имя, и категорию', async () => {
  // категория правится тем же окном, что и имя: отправить одно имя значит молча
  // потерять правку категории, а бэкенд отличает «не прислали» от «снять»
  renderPage({ counterparties: [{ ...denis, category_id: null }] })
  vi.mocked(updateCounterparty).mockResolvedValue(denis)

  await userEvent.click(await screen.findByRole('button', { name: 'Изменить Денис' }))
  await userEvent.clear(await screen.findByLabelText('Имя'))
  await userEvent.type(screen.getByLabelText('Имя'), 'Денис З.')
  await userEvent.click(screen.getByRole('combobox', { name: 'Категория' }))
  await userEvent.click(await screen.findByText('Такси'))
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(updateCounterparty).toHaveBeenCalledWith('ws-1', 'p1', {
    name: 'Денис З.', category_id: 'c1',
  })
})

test('удаление уносит того контрагента, у которого нажали', async () => {
  const maria: Counterparty = {
    id: 'p2', name: 'Мария', kind: 'person', category_id: null, signatures: ['мария к.'],
  }
  renderPage({ counterparties: [denis, maria] })
  vi.mocked(deleteCounterparty).mockResolvedValue(undefined)

  await userEvent.click(await screen.findByRole('button', { name: 'Удалить Мария' }))

  expect(deleteCounterparty).toHaveBeenCalledWith('ws-1', 'p2')
})
