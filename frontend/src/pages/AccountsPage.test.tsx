import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { Account, DiscoveredAccount } from '../api/ledger'
import {
  createAccount,
  getAccounts,
  getBanks,
  getDiscovered,
  linkAccount,
  updateAccount,
} from '../api/ledger'
import { formatMoney } from '../lib/money'
import { useWorkspaceStore } from '../store/workspace'
import { AccountsPage } from './AccountsPage'

// Мокаем клиентские функции api/ledger, а не fetch: проверяем, что показывает
// карточка счёта и с чем уходит правка, а не устройство HTTP-запросов.
vi.mock('../api/ledger', () => ({
  getAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  getBanks: vi.fn(),
  getDiscovered: vi.fn(),
  linkAccount: vi.fn(),
}))

const base: Account = {
  id: 'a1', name: 'Т-Банк', type: 'card', currency: 'RUB', is_archived: false,
  balance: '4900.0000', reported_at: null, card_masks: [], bank_code: null,
  is_bank_linked: false,
  credit_limit: null, credit_limit_at: null, credit_available: null,
}

beforeEach(() => {
  useWorkspaceStore.getState().setWorkspaceId('ws-1')
  vi.clearAllMocks()
})

function renderPage(accounts: Account[], discovered: DiscoveredAccount[] = []) {
  vi.mocked(getAccounts).mockResolvedValue(accounts)
  vi.mocked(getBanks).mockResolvedValue([
    { code: 'tbank', name: 'Т-Банк' },
    { code: 'alfa', name: 'Альфа-Банк' },
  ])
  vi.mocked(getDiscovered).mockResolvedValue(discovered)
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
  renderPage([{ ...base, card_masks: ['1234'] }])

  expect(await screen.findByText('•• 1234')).toBeDefined()
  // цифры заменяют тип, а не дополняют его: у всех карт банка тип одинаковый,
  // и по нему счета друг от друга не отличить
  expect(screen.queryByText('Карта')).toBeNull()
})

test('счёт без карт подписан своим типом', async () => {
  renderPage([{ ...base, name: 'Кошелёк', type: 'cash' }])

  expect(await screen.findByText('Наличные')).toBeDefined()
})

test('счёту с остатком от источника правка остатка не предлагается', async () => {
  renderPage([{ ...base, card_masks: ['1234'], reported_at: '2026-09-03T10:15:00+03:00' }])

  expect(await screen.findByText(/остаток на/)).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Изменить' }))

  // ждём саму форму: содержимое модального окна появляется не в тот же тик,
  // и без ожидания проверка «поля нет» проходила бы всегда
  expect(await screen.findByLabelText('Название')).toBeDefined()
  expect(screen.queryByLabelText('Остаток')).toBeNull()
})

test('счёту без источника остаток правится вручную', async () => {
  renderPage([base])

  await userEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
  await userEvent.type(await screen.findByLabelText('Остаток'), '5100.50')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(updateAccount).toHaveBeenCalledWith('ws-1', 'a1', {
    name: 'Т-Банк', is_archived: undefined, balance: '5100.50',
  })
})

test('остаток с запятой уходит с точкой', async () => {
  // по-русски разделитель — запятая; осмысленное число не должно упираться в 422
  renderPage([base])

  await userEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
  await userEvent.type(await screen.findByLabelText('Остаток'), '5100,50')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(updateAccount).toHaveBeenCalledWith('ws-1', 'a1', {
    name: 'Т-Банк', is_archived: undefined, balance: '5100.50',
  })
})

test('отказ бэкенда в правке остатка виден человеку', async () => {
  // между загрузкой страницы и сохранением источник мог сообщить остаток —
  // тогда правка упирается в 409, и кнопка обязана это объяснить
  renderPage([base])
  vi.mocked(updateAccount).mockRejectedValue(
    new ApiError(409, 'Остаток счёта приходит от источника'),
  )

  await userEvent.click(await screen.findByRole('button', { name: 'Изменить' }))
  await userEvent.type(await screen.findByLabelText('Остаток'), '5100.50')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText('Остаток счёта приходит от источника')).toBeDefined()
})

test('счета разложены по банкам', async () => {
  renderPage([
    { ...base, name: 'Т-карта', bank_code: 'tbank' },
    { ...base, id: 'a2', name: 'Кошелёк', bank_code: null },
  ])

  expect(await screen.findByText('Т-Банк')).toBeDefined()
  expect(await screen.findByText('Без банка')).toBeDefined()
})

test('счёт банка, который не ведётся, предлагается завести', async () => {
  // без этого блока привязка невозможна: отпечаток человеку взять неоткуда
  renderPage(
    [],
    [
      {
        fingerprint: 'a'.repeat(64),
        bank_code: 'alfa',
        bank_name: 'Альфа-Банк',
        name: 'Текущий счёт',
        currency: 'RUB',
        balance: '1000.0000',
        card_masks: ['1234'],
      },
    ],
  )

  expect(await screen.findByText(/есть в банке/i)).toBeDefined()
  expect(await screen.findByText('Текущий счёт')).toBeDefined()
  expect(await screen.findByText('•• 1234')).toBeDefined()
})

test('найденный счёт с отрицательным остатком показан долгом без знака', async () => {
  // у найденного счёта признака кредитки нет — правило по знаку остатка;
  // «−133 330,18 ₽» без слова выглядит как сумма на карте
  renderPage(
    [],
    [
      {
        fingerprint: 'b'.repeat(64),
        bank_code: 'sber',
        bank_name: 'Сбербанк',
        name: 'Кредитная карта',
        currency: 'RUB',
        balance: '-133330.1800',
        card_masks: [],
      },
    ],
  )

  const debt = await screen.findByText(/долг/u)
  expect(debt.textContent?.replace(/\s+/gu, ' ')).toBe(
    `долг ${formatMoney('133330.1800', 'RUB').replace(/\s+/gu, ' ')}`,
  )
})

test('найденный счёт с положительным остатком показан суммой, без «долга»', async () => {
  renderPage(
    [],
    [
      {
        fingerprint: 'c'.repeat(64),
        bank_code: 'alfa',
        bank_name: 'Альфа-Банк',
        name: 'Текущий счёт',
        currency: 'RUB',
        balance: '1000.0000',
        card_masks: [],
      },
    ],
  )

  const amount = await screen.findByText(/1\s000,00/u)
  expect(amount.textContent).not.toMatch(/долг/u)
  expect(screen.queryByText(/долг/u)).toBeNull()
})

test('блока непривязанных нет, когда привязано всё', async () => {
  // пустой заголовок — шум на экране, который человек учится пропускать
  renderPage([{ ...base, name: 'Т-карта', bank_code: 'tbank' }], [])
  expect(await screen.findByText('Т-Банк')).toBeDefined()
  expect(screen.queryByText(/есть в банке/i)).toBeNull()
})

test('заведение счёта из непривязанного уходит с отпечатком банка', async () => {
  // без отпечатка бэкенд не может отличить это заведение от обычного счёта
  // руками — привязка молча не сработает
  renderPage(
    [],
    [
      {
        fingerprint: 'a'.repeat(64),
        bank_code: 'alfa',
        bank_name: 'Альфа-Банк',
        name: 'Текущий счёт',
        currency: 'RUB',
        balance: '1000.0000',
        card_masks: ['1234'],
      },
    ],
  )

  await userEvent.click(await screen.findByRole('button', { name: 'Завести счёт' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))

  expect(createAccount).toHaveBeenCalledWith('ws-1', {
    name: 'Текущий счёт',
    type: 'card',
    currency: 'RUB',
    bank_code: 'alfa',
    bank_account_fingerprint: 'a'.repeat(64),
  })
})

test('без непривязанных счетов у показанного банком счёта только «Завести счёт»', async () => {
  // выбирать было бы не из чего — предлагать привязку в этом случае бессмысленно
  renderPage(
    [],
    [
      {
        fingerprint: 'a'.repeat(64),
        bank_code: 'alfa',
        bank_name: 'Альфа-Банк',
        name: 'Текущий счёт',
        currency: 'RUB',
        balance: '1000.0000',
        card_masks: [],
      },
    ],
  )

  expect(await screen.findByRole('button', { name: 'Завести счёт' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Это мой счёт' })).toBeNull()
})

test('счёт, показанный банком, привязывается к уже заведённому', async () => {
  // у показанного банком счёта — оба действия: завести новый или привязать старый
  renderPage(
    [{ ...base, name: 'Старый счёт' }],
    [
      {
        fingerprint: 'a'.repeat(64),
        bank_code: 'alfa',
        bank_name: 'Альфа-Банк',
        name: 'Текущий счёт',
        currency: 'RUB',
        balance: '1000.0000',
        card_masks: [],
      },
    ],
  )

  expect(await screen.findByRole('button', { name: 'Завести счёт' })).toBeDefined()
  await userEvent.click(await screen.findByRole('button', { name: 'Это мой счёт' }))

  // содержимое модального окна появляется не в тот же тик — ждём его явно
  const dialog = within(await screen.findByRole('dialog'))
  await userEvent.click(dialog.getByRole('combobox', { name: 'Счёт приложения' }))
  // имя счёта совпадает с именем в карточке списка счетов, а выпадающий список
  // Select уходит в отдельный portal вне диалога — из двух совпадений текста
  // на странице берём то, что действительно вариант выбора
  const options = await screen.findAllByText('Старый счёт')
  const option = options.find((el) => el.closest('[role="option"]'))
  if (!option) throw new Error('Вариант выбора счёта не найден')
  await userEvent.click(option)
  await userEvent.click(dialog.getByRole('button', { name: 'Привязать' }))

  // отпечаток и банк уходят от показанного банком счёта, а не от формы
  expect(linkAccount).toHaveBeenCalledWith('ws-1', 'a1', {
    bank_code: 'alfa',
    bank_account_fingerprint: 'a'.repeat(64),
  })
})

test('кредитка в списке счетов показывает «доступно / лимит»', async () => {
  // стык страницы и общего блока: счёт может доехать до него обрезанным, и
  // тогда кредитная часть молча пропадёт
  renderPage([{
    ...base,
    balance: '-148063.8100',
    reported_at: '2026-09-15T10:15:00+03:00',
    credit_limit: '150000.0000',
    credit_limit_at: '2026-09-15T10:15:00+03:00',
    credit_available: '1936.1900',
  }])

  expect(await screen.findByText('доступно к трате')).toBeDefined()
  expect((document.body.textContent ?? '').replace(/\s+/gu, ' ')).toContain('1 936,19 / 150 000,00')
})
