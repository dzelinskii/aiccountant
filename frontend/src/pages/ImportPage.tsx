import { Alert, Button, Card, FileInput, Group, Loader, Select, Stack, Text, Title } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '../api/client'
import { commitImport, getImportStatus, startImport } from '../api/imports'
import { getAccounts } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { ImportPreviewPanel } from './ImportPreviewPanel'

export function ImportPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [accountId, setAccountId] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [importId, setImportId] = useState<string | null>(null)

  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })

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

  return (
    <Stack>
      <Title order={2}>Импорт выписки</Title>
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
