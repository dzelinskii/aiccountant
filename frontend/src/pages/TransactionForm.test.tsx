import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { Account, Category } from '../api/ledger'
import { TransactionForm } from './TransactionForm'

const accounts: Account[] = [
  { id: 'a1', name: 'Карта', type: 'card', currency: 'RUB', is_archived: false, balance: '0.0000' },
]
const categories: Category[] = [{ id: 'c1', parent_id: null, name: 'Еда', kind: 'expense' }]

function renderForm(onSubmit: (v: unknown) => void) {
  return render(
    <MantineProvider>
      <TransactionForm accounts={accounts} categories={categories} onSubmit={onSubmit} pending={false} />
    </MantineProvider>,
  )
}

test('валидация: без счёта не отправляется', async () => {
  const onSubmit = vi.fn()
  renderForm(onSubmit)
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).not.toHaveBeenCalled()
  expect(await screen.findByText('Выберите счёт')).toBeDefined()
})

test('расход без категории уходит с отрицательным знаком', async () => {
  const onSubmit = vi.fn()
  renderForm(onSubmit)
  await userEvent.click(screen.getByRole('combobox', { name: 'Счёт' }))
  await userEvent.click(await screen.findByText('Карта'))
  await userEvent.type(screen.getByLabelText('Сумма'), '500')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ amount: '-500.00', category_id: undefined }),
  )
})

test('доход уходит с положительным знаком', async () => {
  const onSubmit = vi.fn()
  renderForm(onSubmit)
  await userEvent.click(screen.getByText('Доход'))
  await userEvent.click(screen.getByRole('combobox', { name: 'Счёт' }))
  await userEvent.click(await screen.findByText('Карта'))
  await userEvent.type(screen.getByLabelText('Сумма'), '700')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ amount: '700.00' }))
})
