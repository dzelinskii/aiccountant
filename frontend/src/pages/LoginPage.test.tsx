import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { login } from '../api/auth'
import { ApiError } from '../api/client'
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
  await waitFor(() =>
    expect(localStorage.getItem('aiccountant.server')).toBe('http://localhost:18010'),
  )
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

// apiFetch берёт адрес сервера синхронно в момент запроса: сохранённый позже,
// он отправил бы запрос на прежний сервер
test('в приложении адрес сохраняется до запроса, а не после', async () => {
  desktop.on = true
  let seen: string | null = null
  vi.mocked(login).mockImplementationOnce(async () => {
    seen = localStorage.getItem('aiccountant.server')
    return { id: 'u', email: 'a@b.c', session_token: null }
  })
  renderPage()
  const field = screen.getByLabelText('Адрес сервера')
  await userEvent.clear(field)
  await userEvent.type(field, 'http://localhost:18010/')
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
  await waitFor(() => expect(seen).toBe('http://localhost:18010'))
})

test('в приложении поле адреса сервера предзаполнено сохранённым адресом', () => {
  desktop.on = true
  localStorage.setItem('aiccountant.server', 'http://saved:1')
  renderPage()
  expect((screen.getByLabelText('Адрес сервера') as HTMLInputElement).value).toBe('http://saved:1')
})

async function submitWithFailure(error: Error) {
  vi.mocked(login).mockRejectedValueOnce(error)
  renderPage()
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
}

test('в приложении сбой связи объясняется адресом сервера и причиной', async () => {
  desktop.on = true
  await submitWithFailure(new TypeError('Failed to fetch'))
  expect(await screen.findByText(/Не удалось связаться с сервером — проверьте адрес/)).toBeDefined()
  expect(screen.getByText(/Failed to fetch/)).toBeDefined()
})

test('в приложении ответ сервера с ошибкой не выдаётся за проблему адреса', async () => {
  desktop.on = true
  await submitWithFailure(new ApiError(500, 'boom'))
  expect(await screen.findByText('Не удалось войти, попробуйте ещё раз')).toBeDefined()
})

test('в браузере сбой связи остаётся общей ошибкой', async () => {
  await submitWithFailure(new TypeError('Failed to fetch'))
  expect(await screen.findByText('Не удалось войти, попробуйте ещё раз')).toBeDefined()
})
