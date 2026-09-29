import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { login } from '../api/auth'
import { LoginPage } from './LoginPage'

const desktop = { on: false }
vi.mock('../desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('../api/auth', () => ({
  login: vi.fn(async () => ({ id: 'u', email: 'a@b.c', session_token: null })),
}))

beforeEach(() => {
  vi.mocked(login).mockClear()
})

// упавший тест не должен оставить окно «приложением» для соседей
afterEach(() => {
  desktop.on = false
  localStorage.clear()
})

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

test('в браузере поля адреса сервера нет', () => {
  renderPage()
  expect(screen.queryByLabelText('Адрес сервера')).toBeNull()
})

test('в приложении адрес сервера запоминается до входа', async () => {
  desktop.on = true
  renderPage()
  const field = screen.getByLabelText('Адрес сервера')
  await userEvent.clear(field)
  await userEvent.type(field, 'http://localhost:18010/')
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  await waitFor(() => expect(localStorage.getItem('aiccountant.server')).toBe('http://localhost:18010'))
  expect(login).toHaveBeenCalledWith('a@b.c', 'password123')
})

test('в приложении пустой адрес сервера не даёт войти', async () => {
  desktop.on = true
  renderPage()
  await userEvent.clear(screen.getByLabelText('Адрес сервера'))
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  expect(await screen.findByText('Укажите адрес сервера')).toBeDefined()
  expect(login).not.toHaveBeenCalled()
})

test('в браузере адрес сервера не проверяется и не запоминается', async () => {
  renderPage()
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  await waitFor(() => expect(login).toHaveBeenCalled())
  expect(localStorage.getItem('aiccountant.server')).toBeNull()
})
