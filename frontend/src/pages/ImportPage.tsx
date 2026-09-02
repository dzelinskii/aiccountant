import { Alert, Button, Card, FileInput, Group, Loader, Select, Stack, Text, Title } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '../api/client'
import type { ImportListItem } from '../api/imports'
import { commitImport, getImportStatus, getPendingImports, startImport } from '../api/imports'
import { getAccounts } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { ImportPreviewPanel } from './ImportPreviewPanel'

// у импорта от коллектора файла не было: file_name — синтетическая строка вида
// "<парсер>.json", выдавать её за имя файла нельзя, показываем источник
const COLLECTOR_SOURCES: Record<string, string> = {
  tbank_collector: 'Т-Банк, автосбор',
}

function sourceLabel(item: ImportListItem): string {
  if (item.parser === null) return item.file_name
  const collector = COLLECTOR_SOURCES[item.parser]
  if (collector !== undefined) return collector
  // коллектор, ещё не описанный выше: имя файла у него всё равно ненастоящее
  return item.parser.endsWith('_collector') ? 'Автосбор из банка' : item.file_name
}

export function ImportPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [accountId, setAccountId] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [importId, setImportId] = useState<string | null>(null)

  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })
  // импорты от коллектора приходят мимо браузера — без этого списка их не открыть
  const { data: pending } = useQuery({
    queryKey: ['pending-imports', ws],
    queryFn: () => getPendingImports(ws),
  })

  // объявлен раньше startMut, потому что его reset() нужен в onMutate ниже
  const commitMut = useMutation({
    mutationFn: () => commitImport(ws, importId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions', ws] })
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard', ws] })
      // статус станет completed (preview: null) — панель уйдёт вместе со старой кнопкой,
      // а подтверждение об импорте живёт уровнем выше, в самой странице
      await queryClient.invalidateQueries({ queryKey: ['import-status', ws, importId] })
      // импорт стал completed — из списка ожидающих он должен уйти
      await queryClient.invalidateQueries({ queryKey: ['pending-imports', ws] })
    },
  })

  const startMut = useMutation({
    mutationFn: () => startImport(ws, accountId!, file!),
    // сбрасываем ДО запроса, а не в onSuccess: если запрос упадёт, importId и
    // результат предыдущего коммита всё равно не должны продолжать висеть на экране
    onMutate: () => {
      setImportId(null)
      commitMut.reset()
    },
    onSuccess: (started) => setImportId(started.import_id),
  })

  // разбор идёт в фоне (Celery), поэтому опрашиваем статус, пока он не перестанет быть processing
  const statusQuery = useQuery({
    queryKey: ['import-status', ws, importId],
    queryFn: () => getImportStatus(ws, importId!),
    enabled: importId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'processing' ? 1500 : false),
  })
  const status = statusQuery.data
  // при сбое ПЕРВОГО запроса статуса data остаётся undefined — без учёта isError
  // isProcessing навсегда останется true (поллинг уже встал из-за retry: false),
  // и спиннер крутится без возможности восстановиться
  const isProcessing =
    importId !== null && !statusQuery.isError && (status === undefined || status.status === 'processing')

  const reset = () => {
    setImportId(null)
    startMut.reset()
    commitMut.reset()
  }

  // открываем чужой (не загруженный в этой вкладке) импорт: дальше отработают
  // тот же поллинг статуса и та же панель превью
  const openPending = (item: ImportListItem) => {
    reset()
    setImportId(item.import_id)
  }

  return (
    <Stack>
      <Title order={2}>Импорт выписки</Title>

      {pending && pending.length > 0 && (
        <Card withBorder>
          <Title order={4} mb="sm">Ожидают подтверждения</Title>
          <Stack gap="xs">
            {pending.map((item) => (
              <Group key={item.import_id} justify="space-between">
                <Text>
                  {new Date(item.created_at).toLocaleDateString('ru-RU')} — {sourceLabel(item)},
                  операций: {item.operations_count}
                </Text>
                <Button variant="light" onClick={() => openPending(item)}>
                  Открыть
                </Button>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      <Card withBorder>
        <Stack>
          <Select
            label="Счёт"
            placeholder="Куда импортировать"
            data={(accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
            value={accountId}
            onChange={(v) => { setAccountId(v); reset() }}
          />
          <FileInput
            label="Выписка (PDF)"
            placeholder="Выберите файл"
            accept="application/pdf"
            value={file}
            onChange={(f) => { setFile(f); reset() }}
          />
          <Button
            disabled={!accountId || !file}
            loading={startMut.isPending}
            onClick={() => startMut.mutate()}
          >
            Разобрать
          </Button>
          {startMut.isError && (
            <Alert color="red">
              {startMut.error instanceof ApiError ? startMut.error.message : 'Не удалось загрузить выписку'}
            </Alert>
          )}
        </Stack>
      </Card>

      {isProcessing && (
        <Group>
          <Loader size="sm" />
          <Text>Разбираем выписку…</Text>
        </Group>
      )}

      {statusQuery.isError && <Alert color="red">Не удалось получить статус разбора</Alert>}

      {status?.status === 'failed' && (
        <Alert color="red">{status.error ?? 'Не удалось разобрать выписку'}</Alert>
      )}

      {status?.status === 'ready' && status.preview && (
        <ImportPreviewPanel
          preview={status.preview}
          parser={status.parser}
          warnings={status.warnings}
          importing={commitMut.isPending}
          onImport={() => commitMut.mutate()}
        />
      )}

      {commitMut.isError && (
        <Alert color="red">
          {commitMut.error instanceof ApiError ? commitMut.error.message : 'Не удалось импортировать операции'}
        </Alert>
      )}

      {commitMut.isSuccess && commitMut.data && (
        <Alert color="green">Импортировано операций: {commitMut.data.imported}</Alert>
      )}
    </Stack>
  )
}
