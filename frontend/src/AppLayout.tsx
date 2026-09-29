import { AppShell, Burger, Group, NavLink, Text } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink as RouterNavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { getMe, logout } from './api/auth'
import { isDesktop } from './desktop/runtime'

const LINKS = [
  { to: '/', label: 'Дашборд' },
  { to: '/accounts', label: 'Счета' },
  { to: '/categories', label: 'Категории' },
  { to: '/counterparties', label: 'Контрагенты' },
  { to: '/transactions', label: 'Операции' },
  { to: '/recurring', label: 'Регулярные' },
  { to: '/import', label: 'Импорт' },
]

// сбор из банков исполняется в оболочке; в браузере экрана нет
const DESKTOP_LINKS = [{ to: '/banks', label: 'Банки' }]

export function AppLayout() {
  const [opened, { toggle }] = useDisclosure()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe })
  const leave = () => {
    queryClient.clear()
    navigate('/login')
  }
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: leave,
    // в приложении токен стёрт и при отказе сервера, так что оставаться на
    // экранах нечем; в браузере cookie жива, и уходить со страницы нельзя
    onError: () => {
      if (isDesktop()) leave()
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
        {(isDesktop() ? [...LINKS, ...DESKTOP_LINKS] : LINKS).map((l) => (
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
