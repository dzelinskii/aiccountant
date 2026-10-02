import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthGuard } from './AuthGuard'
import { ApiError } from './api/client'
import * as auth from './api/auth'

const desktop = vi.hoisted(() => ({ on: false, token: null as string | null }))
vi.mock('./desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('./desktop/connection', () => ({
  serverUrl: () => 'http://saved.test:18000',
  sessionToken: () => desktop.token,
}))

function renderGuard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={
                <AuthGuard>
                  <div>Защищённый контент</div>
                </AuthGuard>
              }
            />
            <Route path="/login" element={<div>экран входа</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  desktop.on = false
  desktop.token = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('при 500 показывает ошибку, а не редиректит', async () => {
  vi.spyOn(auth, 'getMe').mockRejectedValue(new ApiError(500, 'boom'))
  renderGuard()
  await waitFor(() => expect(screen.getByText(/Не удалось загрузить/i)).toBeDefined())
})

test('показывает контент при успешной сессии', async () => {
  vi.spyOn(auth, 'getMe').mockResolvedValue({ id: '1', email: 'a@a.a', workspaces: [] })
  renderGuard()
  await waitFor(() => expect(screen.getByText('Защищённый контент')).toBeDefined())
})

test('в браузере 401 ведёт на вход', async () => {
  vi.spyOn(auth, 'getMe').mockRejectedValue(new ApiError(401, 'нет сессии'))
  renderGuard()
  await waitFor(() => expect(screen.getByText('экран входа')).toBeDefined())
})

test('в браузере сетевая ошибка — сообщение, а не вход и не смена адреса', async () => {
  vi.spyOn(auth, 'getMe').mockRejectedValue(new TypeError('Failed to fetch'))
  renderGuard()
  await waitFor(() => expect(screen.getByText(/Не удалось загрузить/i)).toBeDefined())
  expect(screen.queryByText('экран входа')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Сменить адрес сервера' })).toBeNull()
})

test('в приложении без токена — сразу вход, не ходя в сеть', async () => {
  desktop.on = true
  const getMe = vi.spyOn(auth, 'getMe').mockResolvedValue({ id: '1', email: 'a@a.a', workspaces: [] })
  renderGuard()
  await waitFor(() => expect(screen.getByText('экран входа')).toBeDefined())
  expect(getMe).not.toHaveBeenCalled()
})

test('в приложении сетевая ошибка — причина и кнопка смены адреса, ведущая на вход', async () => {
  desktop.on = true
  desktop.token = 'tok'
  vi.spyOn(auth, 'getMe').mockRejectedValue(new TypeError('Failed to fetch'))
  renderGuard()
  const button = await screen.findByRole('link', { name: 'Сменить адрес сервера' })
  expect(screen.getByText(/http:\/\/saved\.test:18000/)).toBeDefined()
  expect(screen.getByText(/Failed to fetch/)).toBeDefined()

  await userEvent.click(button)
  await waitFor(() => expect(screen.getByText('экран входа')).toBeDefined())
})

test('в приложении 401 от сервера ведёт на вход, как раньше', async () => {
  desktop.on = true
  desktop.token = 'tok'
  vi.spyOn(auth, 'getMe').mockRejectedValue(new ApiError(401, 'сессия истекла'))
  renderGuard()
  await waitFor(() => expect(screen.getByText('экран входа')).toBeDefined())
})

test('в приложении 500 от сервера — прежнее сообщение без смены адреса', async () => {
  desktop.on = true
  desktop.token = 'tok'
  vi.spyOn(auth, 'getMe').mockRejectedValue(new ApiError(500, 'boom'))
  renderGuard()
  await waitFor(() => expect(screen.getByText(/Не удалось загрузить/i)).toBeDefined())
  expect(screen.queryByRole('link', { name: 'Сменить адрес сервера' })).toBeNull()
})
