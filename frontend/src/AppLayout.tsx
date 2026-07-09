import { AppShell, Burger, Group, NavLink, Text } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink as RouterNavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { getMe, logout } from './api/auth'

const LINKS = [
  { to: '/', label: 'Дашборд' },
  { to: '/accounts', label: 'Счета' },
  { to: '/categories', label: 'Категории' },
  { to: '/transactions', label: 'Операции' },
  { to: '/recurring', label: 'Регулярные' },
  { to: '/import', label: 'Импорт' },
]

export function AppLayout() {
  const [opened, { toggle }] = useDisclosure()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe })
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear()
      navigate('/login')
    },
  })

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Text fw={700}>AIccountant</Text>
          </Group>
          <Group>
            <Text c="dimmed" size="sm">{me?.email}</Text>
            <NavLink label="Выйти" onClick={() => logoutMutation.mutate()} w="auto" />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md">
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            component={RouterNavLink}
            to={l.to}
            label={l.label}
            active={location.pathname === l.to}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
