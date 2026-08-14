import { api, ApiError } from './client'

export interface ImportOperation {
  occurred_at: string
  amount: string
  currency: string
  description: string
  is_duplicate: boolean
}

export interface ImportPreview {
  operations: ImportOperation[]
  new_count: number
  duplicate_count: number
  total_income: string | null
  total_expense: string | null
}

export interface ImportStarted {
  import_id: string
  status: string
}

export interface ImportStatus {
  import_id: string
  status: 'processing' | 'ready' | 'failed' | 'completed'
  parser: string | null
  error: string | null
  warnings: string[]
  preview: ImportPreview | null
}

export interface ImportResult {
  import_id: string
  imported: number
  duplicates: number
}

const q = (ws: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ workspace_id: ws, ...extra }).toString()

// multipart: не выставляем Content-Type вручную — браузер сам добавит boundary
export async function startImport(ws: string, accountId: string, file: File): Promise<ImportStarted> {
  const form = new FormData()
  form.append('file', file)
  const qs = q(ws, { account_id: accountId })
  const res = await fetch(`/api/imports?${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body?.detail ?? res.statusText)
  }
  return res.json() as Promise<ImportStarted>
}

export const getImportStatus = (ws: string, id: string) =>
  api<ImportStatus>(`/api/imports/${id}?${q(ws)}`)

export const commitImport = (ws: string, id: string) =>
  api<ImportResult>(`/api/imports/${id}/commit?${q(ws)}`, { method: 'POST' })
