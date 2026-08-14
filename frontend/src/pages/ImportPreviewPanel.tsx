import { Alert, Badge, Button, Card, Group, Table, Text } from '@mantine/core'
import type { ImportPreview } from '../api/imports'
import { formatMoney } from '../lib/money'

export function ImportPreviewPanel({
  preview,
  parser,
  warnings,
  importing,
  imported,
  onImport,
}: {
  preview: ImportPreview
  parser: string | null
  warnings: string[]
  importing: boolean
  imported: number | null
  onImport: () => void
}) {
  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Group gap="xs">
          {parser === 'llm' && <Badge color="blue">AI-разбор</Badge>}
          {parser && parser !== 'llm' && <Badge color="gray">Т-Банк</Badge>}
          <Text>
            Новых: <b>{preview.new_count}</b>, дублей: {preview.duplicate_count}
          </Text>
        </Group>
        <Button disabled={preview.new_count === 0} loading={importing} onClick={onImport}>
          Импортировать {preview.new_count} новых
        </Button>
      </Group>
      {warnings.map((w) => (
        <Alert color="yellow" mb="sm" key={w}>{w}</Alert>
      ))}
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
