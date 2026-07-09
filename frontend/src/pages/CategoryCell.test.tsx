import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { Transaction } from '../api/ledger'
import { CategoryCell } from './CategoryCell'

const base: Transaction = {
  id: 't1', account_id: 'a1', category_id: null, amount: '-100.00', currency: 'RUB',
  occurred_at: '2026-07-05', merchant: 'Пятёрочка', note: null, transfer_group_id: null,
  category_confirmed: false, suggested_category_id: null, category_confidence: null,
}

function renderCell(t: Transaction) {
  return render(
    <MantineProvider>
      <CategoryCell
        txn={t}
        categoryName={(id) => (id ? 'Еда' : null)}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
      />
    </MantineProvider>,
  )
}

test('показывает бейдж AI у авто-категории без подтверждения', () => {
  renderCell({ ...base, category_id: 'c1', category_confirmed: false })
  expect(screen.getByText('Еда')).toBeDefined()
  expect(screen.getByText('AI')).toBeDefined()
})

test('показывает чип-подсказку с кнопками для suggested', () => {
  renderCell({ ...base, suggested_category_id: 'c1' })
  expect(screen.getByText(/AI: Еда/)).toBeDefined()
  expect(screen.getByLabelText('Подтвердить категорию')).toBeDefined()
  expect(screen.getByLabelText('Отклонить подсказку')).toBeDefined()
})

test('не показывает бейдж AI у подтверждённой категории', () => {
  renderCell({ ...base, category_id: 'c1', category_confirmed: true })
  expect(screen.getByText('Еда')).toBeDefined()
  expect(screen.queryByText('AI')).toBeNull()
})
