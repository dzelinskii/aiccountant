import { ApiError } from './client'

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

export interface ImportResult {
  import_id: string
  imported: number
  duplicates: number
}

// multipart: не выставляем Content-Type вручную — браузер сам добавит boundary
async function upload<T>(ws: string, accountId: string, file: File, commit: boolean): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  const qs = new URLSearchParams({ workspace_id: ws, account_id: accountId, commit: String(commit) })
  const res = await fetch(`/api/imports?${qs.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, body?.detail ?? res.statusText)
  }
  return res.json() as Promise<T>
}

export const previewImport = (ws: string, accountId: string, file: File) =>
  upload<ImportPreview>(ws, accountId, file, false)

export const commitImport = (ws: string, accountId: string, file: File) =>
  upload<ImportResult>(ws, accountId, file, true)
