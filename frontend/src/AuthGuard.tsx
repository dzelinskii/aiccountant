import { Center, Loader } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { getMe } from './api/auth'

export function AuthGuard({ children }: { children: ReactNode }) {
  const { isPending, isError } = useQuery({ queryKey: ['me'], queryFn: getMe })
  if (isPending)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  if (isError) return <Navigate to="/login" replace />
  return <>{children}</>
}
