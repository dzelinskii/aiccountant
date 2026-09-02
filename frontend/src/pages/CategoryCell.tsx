import { ActionIcon, Badge, Group, Text } from '@mantine/core'
import type { Transaction } from '../api/ledger'

interface Props {
  txn: Transaction
  categoryName: (id: string | null) => string | null
  onConfirm: (txn: Transaction) => void
  onDismiss: (txn: Transaction) => void
}

export function CategoryCell({ txn, categoryName, onConfirm, onDismiss }: Props) {
  const name = categoryName(txn.category_id)

  // операции вне статистики категоризация не трогает — подсказок у них не будет.
  // Но заданную человеком категорию прячем не мы: она сохранена и видна, пометка
  // идёт рядом с ней. Участие в статистике считает бэкенд, правило одно
  if (!txn.counts_in_stats) {
    return (
      <Group gap="xs">
        <Text>{name ?? '—'}</Text>
        <Badge size="xs" variant="light" color="gray">Вне статистики</Badge>
      </Group>
    )
  }

  // подсказка ниже порога — предложить подтвердить/отклонить
  if (txn.suggested_category_id && !txn.category_id) {
    const name = categoryName(txn.suggested_category_id) ?? '—'
    return (
      <Group gap="xs">
        <Text c="dimmed" size="sm">{`AI: ${name}`}</Text>
        <ActionIcon
          aria-label="Подтвердить категорию" size="sm" variant="light" color="green"
          onClick={() => onConfirm(txn)}
        >
          ✓
        </ActionIcon>
        <ActionIcon
          aria-label="Отклонить подсказку" size="sm" variant="subtle" color="gray"
          onClick={() => onDismiss(txn)}
        >
          ✗
        </ActionIcon>
      </Group>
    )
  }

  if (!name) return <Text>—</Text>

  // авто-простановка AI ещё не подтверждена человеком — помечаем бейджем
  return (
    <Group gap="xs">
      <Text>{name}</Text>
      {txn.category_id && !txn.category_confirmed && (
        <Badge size="xs" variant="light" color="blue">AI</Badge>
      )}
    </Group>
  )
}
