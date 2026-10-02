import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AppLayout } from './AppLayout'
import { logout } from './api/auth'

const desktop = { on: false }
vi.mock('./desktop/runtime', () => ({ isDesktop: () => desktop.on, invoke: vi.fn() }))
vi.mock('./api/auth', () => ({
  getMe: vi.fn(async () => ({ id: 'u', email: 'a@b.c', workspaces: [] })),
  logout: vi.fn(),
}))

function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<div>содержимое</div>} />
            </Route>
            <Route path="/login" element={<div>экран входа</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
  return { ...view, queryClient }
}

beforeEach(() => {
  vi.mocked(logout).mockReset()
})

afterEach(() => {
  desktop.on = false
})

test('успешный выход ведёт на экран входа', async () => {
  vi.mocked(logout).mockResolvedValueOnce(undefined)
  renderLayout()
  await userEvent.click(screen.getByText('Выйти'))
  expect(await screen.findByText('экран входа')).toBeDefined()
})

test('в приложении после неудачного выхода всё равно экран входа: токен уже стёрт', async () => {
  desktop.on = true
  vi.mocked(logout).mockRejectedValueOnce(new Error('сервер недоступен'))
  renderLayout()
  await userEvent.click(screen.getByText('Выйти'))
  expect(await screen.findByText('экран входа')).toBeDefined()
})

test('в браузере после неудачного выхода остаёмся на месте: сессия на сервере жива', async () => {
  vi.mocked(logout).mockRejectedValueOnce(new Error('сервер недоступен'))
  renderLayout()
  await userEvent.click(screen.getByText('Выйти'))
  await waitFor(() => expect(logout).toHaveBeenCalled())
  expect(screen.queryByText('экран входа')).toBeNull()
  expect(screen.getByText('содержимое')).toBeDefined()
})

// clear() нужен, чтобы данные прежнего пользователя не показались следующему
test('после выхода данные пользователя не остаются в кэше', async () => {
  vi.mocked(logout).mockResolvedValueOnce(undefined)
  const { queryClient } = renderLayout()
  await waitFor(() => expect(queryClient.getQueryData(['me'])).toBeDefined())
  await userEvent.click(screen.getByText('Выйти'))
  await screen.findByText('экран входа')
  expect(queryClient.getQueryData(['me'])).toBeUndefined()
})

test('пункт «Банки» есть в приложении', () => {
  desktop.on = true
  renderLayout()
  expect(screen.getByText('Банки')).toBeDefined()
})

test('в браузере пункта «Банки» нет: сбор работает только в приложении', () => {
  renderLayout()
  expect(screen.queryByText('Банки')).toBeNull()
})
