import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, test } from 'vitest'
import { LoginPage } from './LoginPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

test('рендерит форму входа', () => {
  renderPage()
  expect(screen.getByLabelText('Email')).toBeDefined()
  expect(screen.getByLabelText('Пароль')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Войти' })).toBeDefined()
})

test('показывает ошибки валидации при пустой отправке', async () => {
  renderPage()
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  expect(await screen.findByText('Некорректный email')).toBeDefined()
  expect(screen.getByText('Введите пароль')).toBeDefined()
})
