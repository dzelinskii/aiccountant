import { Card, Grid, Group, Progress, Stack, Table, Text, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { getDashboard } from '../api/ledger'
import { formatMoney } from '../lib/money'
import { useWorkspaceStore } from '../store/workspace'

export function DashboardPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const { data, isPending } = useQuery({
    queryKey: ['dashboard', ws],
    queryFn: () => getDashboard(ws),
  })
  if (isPending || !data) return <Text>Загрузка…</Text>

  const maxExpense = data.month_expenses.reduce(
    (m, e) => Math.max(m, Number(e.total)),
    0,
  )

  return (
    <Stack>
      <Title order={2}>Дашборд</Title>

      <Grid>
        {data.accounts.map((a) => (
          <Grid.Col key={a.id} span={{ base: 12, sm: 6, md: 4 }}>
            <Card withBorder>
              <Text c="dimmed" size="sm">{a.name}</Text>
              <Text fw={700} size="lg">{formatMoney(a.balance, a.currency)}</Text>
            </Card>
          </Grid.Col>
        ))}
      </Grid>

      <Card withBorder>
        <Title order={4} mb="sm">Расходы месяца по категориям</Title>
        {data.month_expenses.length === 0 && <Text c="dimmed">Пока нет расходов</Text>}
        <Stack gap="xs">
          {data.month_expenses.map((e) => (
            <div key={e.category_id}>
              <Group justify="space-between">
                <Text size="sm">{e.category_name}</Text>
                <Text size="sm" fw={500}>{formatMoney(e.total, 'RUB')}</Text>
              </Group>
              <Progress value={maxExpense ? (Number(e.total) / maxExpense) * 100 : 0} />
            </div>
          ))}
        </Stack>
      </Card>

      <Card withBorder>
        <Title order={4} mb="sm">Последние операции</Title>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Дата</Table.Th>
              <Table.Th>Счёт</Table.Th>
              <Table.Th>Категория</Table.Th>
              <Table.Th ta="right">Сумма</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.recent.map((t) => (
              <Table.Tr key={t.id}>
                <Table.Td>{t.occurred_at}</Table.Td>
                <Table.Td>{t.account_name}</Table.Td>
                <Table.Td>{t.is_transfer ? 'Перевод' : (t.category_name ?? '—')}</Table.Td>
                <Table.Td ta="right">{formatMoney(t.amount, t.currency)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  )
}
