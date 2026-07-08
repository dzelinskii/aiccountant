import { Alert, Center, Loader } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { getMe } from './api/auth'
import { ApiError } from './api/client'

export function AuthGuard({ children }: { children: ReactNode }) {
  const { isPending, isError, error } = useQuery({ queryKey: ['me'], queryFn: getMe })
  if (isPending)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  if (isError) {
    // 401 — не авторизован, ведём на вход; прочее (сеть/500) — сообщение об ошибке
    if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />
    return (
      <Center h="100vh">
        <Alert color="red">Не удалось загрузить сессию. Попробуйте обновить страницу.</Alert>
      </Center>
    )
  }
  return <>{children}</>
}
