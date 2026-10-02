import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  AppHttpError,
  BankSessionExpiredError,
  type AccountResult,
  type CollectSummary,
} from 'aiccountant-collector/src/app'
import { ACCOUNT_NOTES } from 'aiccountant-collector/src/core/account-notes'
import type { Account } from '../api/ledger'
import { getAccounts, getBanks } from '../api/ledger'
import { collectFromApp, forgetBank } from '../desktop/collector-host'
import { useCollectStore } from '../store/collect'
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
  appAccountId: 'a-sber', collected: 3, importId: 'imp-1', counters: noCounters, error: null, notes: [], ...over,
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
  useCollectStore.getState().reset()
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
  const { unmount } = render(
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
  return { queryClient, invalidate, unmount }
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

test('пояснение сбора по счёту видно в итоге рядом со счётчиками', async () => {
  // без него кредитка без остатка выглядит как «остаток не обновился» без причины
  const note = ACCOUNT_NOTES.creditBalanceMissing
  vi.mocked(collectFromApp).mockResolvedValue(summary({ accounts: [result({ notes: [note] })] }))
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(note)).toBeDefined()
})

test('пояснение видно и у счёта с отказом: оно о счёте, а не об операциях', async () => {
  const note = ACCOUNT_NOTES.creditBalanceMissing
  vi.mocked(collectFromApp).mockResolvedValue(
    summary({ accounts: [result({ collected: 0, importId: null, error: 'банк отказал', notes: [note] })] }),
  )
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText(/банк отказал/)).toBeDefined()
  expect(row('sber').getByText(note)).toBeDefined()
})

test('сбор банка целиком провалился: «Имя банка: текст»', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new Error('Нет входа в приложение'))
  await renderPage()

  await userEvent.click(row('sber').getByRole('button', { name: 'Собрать' }))

  expect(await row('sber').findByText('Сбербанк: Нет входа в приложение')).toBeDefined()
})

const isDisabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled
const collectButton = (code: string) => row(code).getByRole('button', { name: 'Собрать' })
const forgetButton = (code: string) => row(code).getByRole('button', { name: /забыть/i })
const collectAllButton = () => screen.getByRole('button', { name: 'Собрать всё' })

// после любого исхода банк должен быть свободен: залипшая кнопка оставила бы
// человека без сбора до перезапуска приложения
async function expectAllIdle() {
  await waitFor(() => expect(isDisabled(collectButton('sber'))).toBe(false))
  expect(isDisabled(forgetButton('sber'))).toBe(false)
  expect(isDisabled(collectButton('alfa'))).toBe(false)
  expect(isDisabled(collectAllButton())).toBe(false)
}

// ждём, пока очередные микрозадачи и таймеры отработают: отсутствие вызова
// нельзя дождаться через waitFor
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))

test('401 в «Собрать всё» прерывает очередь: остальные банки не трогаются, кнопки свободны', async () => {
  vi.mocked(collectFromApp).mockRejectedValueOnce(new AppHttpError(401, ''))
  await renderPage()

  await userEvent.click(collectAllButton())

  await expectAllIdle()
  await settle()
  expect(collectFromApp).toHaveBeenCalledTimes(1)
})

test('после отказа сбора банк и «Собрать всё» снова активны', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new Error('банк не отвечает'))
  await renderPage()

  await userEvent.click(collectButton('sber'))

  await row('sber').findByText(/банк не отвечает/)
  await expectAllIdle()
})

test('после смерти сессии банка кнопки снова активны', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new BankSessionExpiredError([]))
  await renderPage()

  await userEvent.click(collectButton('sber'))

  await row('sber').findByText(/войти заново/)
  await expectAllIdle()
})

test('после отказа «Забыть доступ» кнопки снова активны, а ошибка показана', async () => {
  vi.mocked(forgetBank).mockRejectedValue(new Error('хранилище недоступно'))
  await renderPage()

  await userEvent.click(forgetButton('sber'))
  await userEvent.click(forgetButton('sber'))

  await row('sber').findByText('Сбербанк: хранилище недоступно')
  await expectAllIdle()
})

test('обновление данных идёт и после отказа сбора: импорты могли уйти до сбоя', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(new Error('банк не отвечает'))
  const { invalidate } = await renderPage()

  await userEvent.click(collectButton('sber'))

  await waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pending-imports', 'ws-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['discovered', 'ws-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accounts', 'ws-1'] })
  })
})

test('«Собрать всё» идёт строго по одному, и банк очереди занят до своего хода', async () => {
  const pending: Array<(value: CollectSummary) => void> = []
  vi.mocked(collectFromApp).mockImplementation(
    () => new Promise<CollectSummary>((resolve) => { pending.push(resolve) }),
  )
  await renderPage()

  await userEvent.click(collectAllButton())

  await waitFor(() => expect(collectFromApp).toHaveBeenCalledTimes(1))
  await settle()
  expect(collectFromApp).toHaveBeenCalledTimes(1)
  // у alfa своей работы ещё нет, но её очередь не должна перехватываться отдельным нажатием
  expect(isDisabled(collectButton('alfa'))).toBe(true)
  expect(isDisabled(forgetButton('alfa'))).toBe(true)

  pending[0](summary())
  await waitFor(() => expect(collectFromApp).toHaveBeenCalledTimes(2))
  expect(isDisabled(collectButton('alfa'))).toBe(true)

  pending[1](summary({ bank: 'alfa', accounts: [result({ appAccountId: 'a-alfa' })] }))
  await expectAllIdle()
})

test('итог банка в очереди не пропадает, пока до него не дошла очередь', async () => {
  vi.mocked(collectFromApp).mockResolvedValueOnce(summary({ bank: 'alfa', accounts: [result({ appAccountId: 'a-alfa' })] }))
  await renderPage()
  await userEvent.click(collectButton('alfa'))
  await row('alfa').findByText(/собрано 3/)

  let release: (value: CollectSummary) => void = () => {}
  vi.mocked(collectFromApp).mockReturnValueOnce(new Promise<CollectSummary>((resolve) => { release = resolve }))
  await userEvent.click(collectAllButton())

  await waitFor(() => expect(collectFromApp).toHaveBeenCalledTimes(2))
  expect(row('alfa').getByText(/собрано 3/)).toBeDefined()
  release(summary())
})

test('смерть сессии: счёт с ошибкой и без импорта тоже виден, а «ждут решения» — только при импорте', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(
    new BankSessionExpiredError([
      result({ collected: 5, importId: 'imp-9' }),
      result({ appAccountId: 'a-alfa', collected: 0, importId: null, error: 'банк отказал' }),
    ]),
  )
  await renderPage()

  await userEvent.click(collectButton('sber'))

  expect(await row('sber').findByText(/банк отказал/)).toBeDefined()
  expect(row('sber').getByText(/собрано 5/)).toBeDefined()
  expect(row('sber').getByText(/ждут решения/)).toBeDefined()
})

test('смерть сессии: если импортов нет, «ждут решения» не пишется, а ошибка счёта видна', async () => {
  vi.mocked(collectFromApp).mockRejectedValue(
    new BankSessionExpiredError([
      result({ collected: 0, importId: null, error: 'банк отказал' }),
    ]),
  )
  await renderPage()

  await userEvent.click(collectButton('sber'))

  expect(await row('sber').findByText(/банк отказал/)).toBeDefined()
  expect(row('sber').queryByText(/ждут решения/)).toBeNull()
})

test('после подтверждённого «Забыть доступ» метка возвращается, и одиночное нажатие уже не забывает', async () => {
  vi.mocked(forgetBank).mockResolvedValue(undefined)
  await renderPage()

  await userEvent.click(forgetButton('sber'))
  await userEvent.click(forgetButton('sber'))
  await waitFor(() => expect(forgetBank).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(isDisabled(forgetButton('sber'))).toBe(false))

  expect(forgetButton('sber').textContent).toBe('Забыть доступ')
  await userEvent.click(forgetButton('sber'))
  expect(forgetBank).toHaveBeenCalledTimes(1)
})

test('«Собрать» снимает начатое подтверждение «Забыть»: следующее нажатие снова первое', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary())
  vi.mocked(forgetBank).mockResolvedValue(undefined)
  await renderPage()

  await userEvent.click(forgetButton('sber'))
  expect(forgetButton('sber').textContent).toBe('Точно забыть?')
  await userEvent.click(collectButton('sber'))
  await row('sber').findByText(/собрано 3/)

  expect(forgetButton('sber').textContent).toBe('Забыть доступ')
  await userEvent.click(forgetButton('sber'))
  expect(forgetBank).not.toHaveBeenCalled()
})

test('«Собрать всё» тоже снимает подтверждение «Забыть» у банков очереди', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary())
  await renderPage()

  await userEvent.click(forgetButton('sber'))
  await userEvent.click(collectAllButton())

  await waitFor(() => expect(collectFromApp).toHaveBeenCalledTimes(2))
  await expectAllIdle()
  expect(forgetButton('sber').textContent).toBe('Забыть доступ')
})

test('сессия из хранилища подписана так, а не «свежий вход»', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary({ session: 'stored' }))
  await renderPage()

  await userEvent.click(collectButton('sber'))

  expect(await row('sber').findByText(/Сессия: из хранилища/)).toBeDefined()
  expect(row('sber').queryByText(/свежий вход/)).toBeNull()
})

test('когда все счета банка привязаны, «В банке ещё» не пишется', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary({ unboundCount: 0 }))
  await renderPage()

  await userEvent.click(collectButton('sber'))

  await row('sber').findByText(/собрано 3/)
  expect(row('sber').queryByText(/В банке ещё/)).toBeNull()
})

test('пустой итог при непривязанных счетах банка: только «Ни один счёт», без повтора числа', async () => {
  vi.mocked(collectFromApp).mockResolvedValue(summary({ accounts: [], unboundCount: 2 }))
  await renderPage()

  await userEvent.click(collectButton('sber'))

  expect(await row('sber').findByText(/Ни один счёт банка не привязан/)).toBeDefined()
  expect(row('sber').queryByText(/В банке ещё/)).toBeNull()
})

// сбор, который закончится, когда тест скажет: так экран можно покинуть посреди сбора
function pendingCollect() {
  let finish: (value: CollectSummary) => void = () => {}
  vi.mocked(collectFromApp).mockReturnValueOnce(new Promise<CollectSummary>((resolve) => { finish = resolve }))
  return (value: CollectSummary) => finish(value)
}

test('итог сбора, закончившегося после ухода с экрана, виден при возвращении, и банк свободен', async () => {
  const finish = pendingCollect()
  const { unmount } = await renderPage()
  await userEvent.click(collectButton('sber'))
  await waitFor(() => expect(isDisabled(collectButton('sber'))).toBe(true))

  unmount()
  finish(summary())
  await settle()
  await renderPage()

  expect(row('sber').getByText(/собрано 3/)).toBeDefined()
  await expectAllIdle()
})

test('вернувшись на экран посреди сбора, кнопки занятого банка неактивны, пока сбор не кончится', async () => {
  const finish = pendingCollect()
  const { unmount } = await renderPage()
  await userEvent.click(collectButton('sber'))
  await waitFor(() => expect(isDisabled(collectButton('sber'))).toBe(true))

  unmount()
  await renderPage()

  expect(isDisabled(collectButton('sber'))).toBe(true)
  expect(isDisabled(forgetButton('sber'))).toBe(true)
  expect(isDisabled(collectAllButton())).toBe(true)
  expect(isDisabled(collectButton('alfa'))).toBe(false)

  finish(summary())
  expect(await row('sber').findByText(/собрано 3/)).toBeDefined()
  await expectAllIdle()
})

test('итог сбора остаётся в своём рабочем пространстве, даже если оно сменилось посреди сбора', async () => {
  const finish = pendingCollect()
  await renderPage()
  await userEvent.click(collectButton('sber'))
  await waitFor(() => expect(isDisabled(collectButton('sber'))).toBe(true))

  act(() => useWorkspaceStore.getState().setWorkspaceId('ws-2'))
  finish(summary())
  await settle()

  expect(row('sber').queryByText(/собрано 3/)).toBeNull()
  expect(isDisabled(collectAllButton())).toBe(false)

  act(() => useWorkspaceStore.getState().setWorkspaceId('ws-1'))
  expect(await row('sber').findByText(/собрано 3/)).toBeDefined()
})

// выход и вход сбрасывают хранилище (AppLayout, LoginPage, RegisterPage); здесь —
// что сбор, переживший сброс, итог прежнего пользователя обратно не вернёт
test('сбор, закончившийся после выхода, итог не пишет, и очередь «Собрать всё» дальше не идёт', async () => {
  const finish = pendingCollect()
  const { unmount } = await renderPage()
  await userEvent.click(collectAllButton())
  await waitFor(() => expect(collectFromApp).toHaveBeenCalledTimes(1))
  unmount()

  act(() => useCollectStore.getState().reset())
  finish(summary())
  await settle()

  expect(useCollectStore.getState().byWorkspace).toEqual({})
  expect(collectFromApp).toHaveBeenCalledTimes(1)
})

test('«Забыть доступ», закончившийся после выхода, в хранилище ничего не пишет', async () => {
  let release: () => void = () => {}
  vi.mocked(forgetBank).mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))
  const { unmount } = await renderPage()
  await userEvent.click(forgetButton('sber'))
  await userEvent.click(forgetButton('sber'))
  await waitFor(() => expect(forgetBank).toHaveBeenCalledTimes(1))
  unmount()

  act(() => useCollectStore.getState().reset())
  release()
  await settle()

  expect(useCollectStore.getState().byWorkspace).toEqual({})
})
