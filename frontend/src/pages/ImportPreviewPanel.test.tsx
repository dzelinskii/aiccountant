import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { ImportPreview } from '../api/imports'
import { ImportPreviewPanel } from './ImportPreviewPanel'

const preview: ImportPreview = {
  operations: [
    { occurred_at: '2026-07-04', amount: '-1150.0000', currency: 'RUB', description: 'Перевод', is_duplicate: false },
    { occurred_at: '2026-07-02', amount: '5000.0000', currency: 'RUB', description: 'Пополнение', is_duplicate: true },
  ],
  new_count: 1,
  duplicate_count: 1,
  total_income: '5000.0000',
  total_expense: '1150.0000',
}

function renderPanel(onImport: () => void) {
  return render(
    <MantineProvider>
      <ImportPreviewPanel preview={preview} importing={false} imported={null} onImport={onImport} />
    </MantineProvider>,
  )
}

test('показывает счётчики и строки', () => {
  renderPanel(vi.fn())
  expect(screen.getByText(/Новых:/)).toBeDefined()
  expect(screen.getByText('Перевод')).toBeDefined()
  expect(screen.getByText('дубль')).toBeDefined()
})

test('кнопка импорта зовёт onImport', async () => {
  const onImport = vi.fn()
  renderPanel(onImport)
  await userEvent.click(screen.getByRole('button', { name: /Импортировать/ }))
  expect(onImport).toHaveBeenCalled()
})
