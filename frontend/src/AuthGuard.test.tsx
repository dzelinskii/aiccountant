import { MantineProvider } from '@mantine/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, test, vi } from 'vitest'
import { AuthGuard } from './AuthGuard'
import { ApiError } from './api/client'
import * as auth from './api/auth'

function renderGuard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AuthGuard>
            <div>Защищённый контент</div>
          </AuthGuard>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

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
