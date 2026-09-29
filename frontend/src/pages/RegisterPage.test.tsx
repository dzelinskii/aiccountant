import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { register } from '../api/auth'
import { RegisterPage } from './RegisterPage'

const desktop = { on: false }
vi.mock('../desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('../api/auth', () => ({
  register: vi.fn(async () => ({ id: 'u', email: 'a@b.c', session_token: null })),
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RegisterPage />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  vi.mocked(register).mockClear()
})

// упавший тест не должен оставить окно «приложением» для соседей
afterEach(() => {
  desktop.on = false
  localStorage.clear()
})

test('в браузере поля адреса сервера нет', () => {
  renderPage()
  expect(screen.queryByLabelText('Адрес сервера')).toBeNull()
})

test('в приложении адрес сервера запоминается до регистрации', async () => {
  desktop.on = true
  renderPage()
  const field = screen.getByLabelText('Адрес сервера')
  await userEvent.clear(field)
  await userEvent.type(field, 'http://localhost:18010/')
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
  await waitFor(() =>
    expect(localStorage.getItem('aiccountant.server')).toBe('http://localhost:18010'),
  )
  expect(register).toHaveBeenCalledWith('a@b.c', 'password123')
})

test('в приложении пустой адрес сервера не даёт зарегистрироваться', async () => {
  desktop.on = true
  renderPage()
  await userEvent.clear(screen.getByLabelText('Адрес сервера'))
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
  expect(await screen.findByText('Укажите адрес сервера')).toBeDefined()
  expect(register).not.toHaveBeenCalled()
})
