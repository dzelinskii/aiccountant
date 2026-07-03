import { Button, Card, Container, Group, Text, Title } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getMe, logout } from '../api/auth'

export function HomePage() {
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
    <Container size="md" mt="xl">
      <Group justify="space-between">
        <Title>AIccountant</Title>
        <Group>
          <Text c="dimmed">{me?.email}</Text>
          <Button
            variant="light"
            onClick={() => logoutMutation.mutate()}
            loading={logoutMutation.isPending}
          >
            Выйти
          </Button>
        </Group>
      </Group>
      {me?.workspaces.map((ws) => (
        <Card key={ws.id} withBorder mt="lg">
          <Text fw={500}>{ws.name}</Text>
          <Text size="sm" c="dimmed">
            Ваша роль: {ws.role === 'owner' ? 'владелец' : 'участник'}
          </Text>
        </Card>
      ))}
    </Container>
  )
}
