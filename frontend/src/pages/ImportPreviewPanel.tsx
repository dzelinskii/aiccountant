import { Alert, Badge, Button, Card, Group, Table, Text } from '@mantine/core'
import type { ImportPreview } from '../api/imports'
import { formatMoney } from '../lib/money'

export function ImportPreviewPanel({
  preview,
  importing,
  imported,
  onImport,
}: {
  preview: ImportPreview
  importing: boolean
  imported: number | null
  onImport: () => void
}) {
  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Text>
          Новых: <b>{preview.new_count}</b>, дублей: {preview.duplicate_count}
        </Text>
        <Button disabled={preview.new_count === 0} loading={importing} onClick={onImport}>
          Импортировать {preview.new_count} новых
        </Button>
      </Group>
      {imported !== null && <Alert color="green" mb="sm">Импортировано операций: {imported}</Alert>}
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Дата</Table.Th>
            <Table.Th>Описание</Table.Th>
            <Table.Th ta="right">Сумма</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {preview.operations.map((op, i) => (
            <Table.Tr key={i}>
              <Table.Td>{op.occurred_at}</Table.Td>
              <Table.Td>{op.description}</Table.Td>
              <Table.Td ta="right">{formatMoney(op.amount, op.currency)}</Table.Td>
              <Table.Td>
                {op.is_duplicate ? <Badge color="gray">дубль</Badge> : <Badge color="green">новая</Badge>}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  )
}
