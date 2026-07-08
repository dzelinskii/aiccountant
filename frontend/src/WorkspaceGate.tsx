import { Center, Loader } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { getMe } from './api/auth'
import { useWorkspaceStore } from './store/workspace'

export function WorkspaceGate() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe })
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId)
  const workspaceId = useWorkspaceStore((s) => s.workspaceId)

  useEffect(() => {
    if (me && me.workspaces.length > 0) setWorkspaceId(me.workspaces[0].id)
  }, [me, setWorkspaceId])

  if (!workspaceId)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  return <Outlet />
}
