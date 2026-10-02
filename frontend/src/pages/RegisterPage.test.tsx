import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { register } from '../api/auth'
import { ApiError, detailToMessage } from '../api/client'
import { useCollectStore } from '../store/collect'
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

test('успешная регистрация стирает итоги сборов прежнего пользователя', async () => {
  useCollectStore.getState().setBank('ws-1', 'sber', { running: false, error: 'Сбербанк: банк не отвечает' })
  renderPage()
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
  await waitFor(() => expect(useCollectStore.getState().byWorkspace).toEqual({}))
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

test('в браузере адрес сервера не проверяется и не запоминается', async () => {
  renderPage()
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
  await waitFor(() => expect(register).toHaveBeenCalled())
  expect(localStorage.getItem('aiccountant.server')).toBeNull()
})

// apiFetch берёт адрес сервера синхронно в момент запроса: сохранённый позже,
// он отправил бы запрос на прежний сервер
test('в приложении адрес сохраняется до запроса, а не после', async () => {
  desktop.on = true
  let seen: string | null = null
  vi.mocked(register).mockImplementationOnce(async () => {
    seen = localStorage.getItem('aiccountant.server')
    return { id: 'u', email: 'a@b.c', session_token: null }
  })
  renderPage()
  const field = screen.getByLabelText('Адрес сервера')
  await userEvent.clear(field)
  await userEvent.type(field, 'http://localhost:18010/')
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
  await waitFor(() => expect(seen).toBe('http://localhost:18010'))
})

test('в приложении поле адреса сервера предзаполнено сохранённым адресом', () => {
  desktop.on = true
  localStorage.setItem('aiccountant.server', 'http://saved:1')
  renderPage()
  expect((screen.getByLabelText('Адрес сервера') as HTMLInputElement).value).toBe('http://saved:1')
})

async function submitWithFailure(error: Error) {
  vi.mocked(register).mockRejectedValueOnce(error)
  renderPage()
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c')
  await userEvent.type(screen.getByLabelText('Пароль'), 'password123')
  await userEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
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
  expect(await screen.findByText('Не удалось зарегистрироваться, попробуйте ещё раз')).toBeDefined()
})

test('в браузере сбой связи остаётся общей ошибкой', async () => {
  await submitWithFailure(new TypeError('Failed to fetch'))
  expect(await screen.findByText('Не удалось зарегистрироваться, попробуйте ещё раз')).toBeDefined()
})

// то, что FastAPI отдаёт на email, не прошедший проверку адреса сервером
const pydanticDetail = [
  {
    type: 'value_error',
    loc: ['body', 'email'],
    msg: 'value is not a valid email address: reserved name',
  },
]

test('на 422 показывается пояснение сервера', async () => {
  await submitWithFailure(new ApiError(422, detailToMessage(pydanticDetail) ?? ''))
  expect(
    await screen.findByText(
      'Сервер отклонил данные: value is not a valid email address: reserved name',
    ),
  ).toBeDefined()
})

test('на 422 без пояснения остаётся общая ошибка', async () => {
  await submitWithFailure(new ApiError(422, ''))
  expect(await screen.findByText('Не удалось зарегистрироваться, попробуйте ещё раз')).toBeDefined()
})

test('на 409 объясняется, что email уже занят', async () => {
  await submitWithFailure(new ApiError(409, 'Email already registered'))
  expect(await screen.findByText('Такой email уже зарегистрирован')).toBeDefined()
})
