import { Alert, Badge, Button, Card, Group, Table, Text } from '@mantine/core'
import type { ImportPreview } from '../api/imports'
import { formatMoney } from '../lib/money'

// реестр парсеров: подпись бейджа по имени парсера с бэкенда;
// незнакомое имя (новый банк, ещё не описанный тут) показываем как есть
const PARSER_LABELS: Record<string, string> = {
  llm: 'AI-разбор',
  tbank_statement: 'Т-Банк',
}

export function ImportPreviewPanel({
  preview,
  parser,
  warnings,
  importing,
  onImport,
}: {
  preview: ImportPreview
  parser: string | null
  warnings: string[]
  importing: boolean
  onImport: () => void
}) {
  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Group gap="xs">
          {parser && <Badge color={parser === 'llm' ? 'blue' : 'gray'}>{PARSER_LABELS[parser] ?? parser}</Badge>}
          <Text>
            Новых: <b>{preview.new_count}</b>, дублей: {preview.duplicate_count}
          </Text>
        </Group>
        <Button disabled={preview.new_count === 0} loading={importing} onClick={onImport}>
          Импортировать {preview.new_count} новых
        </Button>
      </Group>
      {warnings.map((w, i) => (
        <Alert color="yellow" mb="sm" key={i}>{w}</Alert>
      ))}
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
