import { Alert, Button, Center, Loader, Stack } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { getMe } from './api/auth'
import { ApiError } from './api/client'
import { serverUrl, sessionToken } from './desktop/connection'
import { isDesktop } from './desktop/runtime'

export function AuthGuard({ children }: { children: ReactNode }) {
  // приложению без токена сервер всё равно ответил бы 401, а по неверному адресу
  // не ответил бы вовсе — экран входа, где этот адрес меняется, нужен сразу
  const signedOut = isDesktop() && sessionToken() === null
  const { isPending, isError, error } = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: !signedOut,
  })
  if (signedOut) return <Navigate to="/login" replace />
  if (isPending)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  if (isError) {
    // 401 — не авторизован, ведём на вход; прочее (сеть/500) — сообщение об ошибке
    if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />
    // в приложении адрес сервера хранится, и ошибка в нём не лечится обновлением:
    // без выхода на экран входа человек остался бы взаперти
    if (isDesktop() && !(error instanceof ApiError)) {
      return (
        <Center h="100vh">
          <Stack align="center">
            <Alert color="red">
              Не удалось связаться с сервером {serverUrl()}. {error.message}
            </Alert>
            <Button component={Link} to="/login">
              Сменить адрес сервера
            </Button>
          </Stack>
        </Center>
      )
    }
    return (
      <Center h="100vh">
        <Alert color="red">Не удалось загрузить сессию. Попробуйте обновить страницу.</Alert>
      </Center>
    )
  }
  return <>{children}</>
}
