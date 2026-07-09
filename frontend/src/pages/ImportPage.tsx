import { Alert, Button, Card, FileInput, Select, Stack, Title } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { commitImport, previewImport, type ImportPreview } from '../api/imports'
import { getAccounts } from '../api/ledger'
import { useWorkspaceStore } from '../store/workspace'
import { ImportPreviewPanel } from './ImportPreviewPanel'

export function ImportPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [accountId, setAccountId] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)

  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })

  const previewMut = useMutation({
    mutationFn: () => previewImport(ws, accountId!, file!),
    onSuccess: setPreview,
  })
  const commitMut = useMutation({
    mutationFn: () => commitImport(ws, accountId!, file!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions', ws] })
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard', ws] })
    },
  })

  const reset = () => {
    setPreview(null)
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
            label="PDF-выписка Т-Банка"
            placeholder="Выберите файл"
            accept="application/pdf"
            value={file}
            onChange={(f) => { setFile(f); reset() }}
          />
          <Button
            disabled={!accountId || !file}
            loading={previewMut.isPending}
            onClick={() => previewMut.mutate()}
          >
            Разобрать
          </Button>
          {previewMut.isError && <Alert color="red">Не удалось разобрать выписку</Alert>}
        </Stack>
      </Card>

      {preview && (
        <ImportPreviewPanel
          preview={preview}
          importing={commitMut.isPending}
          imported={commitMut.data?.imported ?? null}
          onImport={() => commitMut.mutate()}
        />
      )}
    </Stack>
  )
}
