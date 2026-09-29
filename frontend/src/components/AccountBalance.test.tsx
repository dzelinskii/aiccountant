import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { formatMoney } from '../lib/money'
import { AccountBalance, type AccountBalanceProps } from './AccountBalance'

const debit: AccountBalanceProps['account'] = {
  currency: 'RUB',
  balance: '4900.0000',
  reported_at: '2026-09-15T10:15:00+03:00',
  credit_limit: null,
  credit_limit_at: null,
  credit_available: null,
}

// живые числа Сбербанка: лимит 150 000, долг 148 063.81, доступно 1 936.19
const credit: AccountBalanceProps['account'] = {
  currency: 'RUB',
  balance: '-148063.8100',
  reported_at: '2026-09-15T10:15:00+03:00',
  credit_limit: '150000.0000',
  credit_limit_at: '2026-09-15T10:15:00+03:00',
  credit_available: '1936.1900',
}

// пробелы в русских числах Intl ставит неразрывные — приводим к обычным, чтобы
// ожидание в тесте можно было написать руками. Той же нормализации подвергается
// и число из formatMoney, иначе сравнение разошлось бы на невидимом символе
function norm(text: string): string {
  return text.replace(/\s+/gu, ' ')
}

function shown(): string {
  return norm(document.body.textContent ?? '')
}

function renderBalance(account: AccountBalanceProps['account']) {
  return render(
    <MantineProvider>
      <AccountBalance account={account} />
    </MantineProvider>,
  )
}

test('у кредитки главное число — доступно к трате, рядом лимит', () => {
  renderBalance(credit)

  expect(shown()).toContain('1 936,19 / 150 000,00')
  expect(screen.getByText('доступно к трате')).toBeDefined()
})

test('остаток кредитки с карточки не исчезает', () => {
  // он нужен, когда смотришь «сколько должен», и он же складывается в сумму по
  // счетам — просто перестаёт быть главным числом
  renderBalance(credit)

  // минус обязателен: без него «остаток 148 063,81» читается как деньги на счёте
  expect(shown()).toContain(norm(`остаток ${formatMoney('-148063.8100', 'RUB')}`))
})

test('лимит не показывается вместо доступного', () => {
  // сторож против перепутанного порядка: 150 000 главным числом означало бы
  // «у меня есть 150 тысяч», хотя почти всё это долг. Проверяем по началу
  // строки числа, а не по паре целиком: при перестановке знак валюты переезжает
  // внутрь, и регулярка на пару перестала бы совпадать, ничего не поймав
  renderBalance(credit)

  expect(shown()).not.toMatch(/150 000,00[^/]*\//u)
})

test('лимит известен на другой момент — доступное не показывается вовсе', () => {
  // экранный близнец главного правила: число из двух разных сборов выглядело бы
  // достоверно, поэтому его нет, а лимит остаётся с пометкой о своём моменте
  renderBalance({ ...credit, credit_available: null })

  expect(shown()).not.toContain('1 936,19')
  expect(shown()).toContain('лимит 150 000,00')
  expect(screen.getByText(/замечен/u)).toBeDefined()
  expect(screen.queryByText('доступно к трате')).toBeNull()
})

test('перерасход показывается минусом, а не нулём', () => {
  renderBalance({ ...credit, balance: '-150000.0000', credit_available: '-8000.0000' })

  expect(shown()).toContain('-8 000,00 / 150 000,00')
})

test('счёт без лимита выглядит как раньше', () => {
  renderBalance(debit)

  expect(shown()).toContain('4 900,00')
  expect(shown()).toMatch(/остаток на/u)
  expect(screen.queryByText(/лимит/u)).toBeNull()
  expect(screen.queryByText('доступно к трате')).toBeNull()
})

test('счёт без источника момента не показывает', () => {
  renderBalance({ ...debit, reported_at: null })

  expect(shown()).toContain('4 900,00')
  expect(screen.queryByText(/остаток на/u)).toBeNull()
})
