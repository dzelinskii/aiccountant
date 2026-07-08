import { api } from './client'

export type Period = 'day' | 'week' | 'month' | 'year'
export type Mode = 'autopost' | 'remind'

export interface RecurringRule {
  id: string
  account_id: string
  category_id: string
  amount: string
  currency: string
  period: Period
  interval: number
  anchor_day: number | null
  start_date: string
  next_run_at: string
  mode: Mode
  is_active: boolean
  end_date: string | null
  note: string | null
}

export interface Occurrence {
  id: string
  rule_id: string
  due_date: string
  amount: string
  status: string
  transaction_id: string | null
}

export interface RuleInput {
  account_id: string
  category_id: string
  amount: string
  period: Period
  interval: number
  anchor_day: number | null
  start_date: string
  mode: Mode
  end_date?: string | null
  note?: string | null
}

const q = (ws: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ workspace_id: ws, ...extra }).toString()

export const getRules = (ws: string) => api<RecurringRule[]>(`/api/recurring?${q(ws)}`)

export const createRule = (ws: string, body: RuleInput) =>
  api<RecurringRule>(`/api/recurring?${q(ws)}`, { method: 'POST', body: JSON.stringify(body) })

export const updateRule = (
  ws: string, id: string,
  body: { amount?: string; interval?: number; anchor_day?: number | null; mode?: Mode; is_active?: boolean; end_date?: string | null; note?: string | null },
) => api<RecurringRule>(`/api/recurring/${id}?${q(ws)}`, { method: 'PATCH', body: JSON.stringify(body) })

export const deleteRule = (ws: string, id: string) =>
  api<void>(`/api/recurring/${id}?${q(ws)}`, { method: 'DELETE' })

export const getOccurrences = (ws: string, status = 'pending') =>
  api<Occurrence[]>(`/api/recurring/occurrences?${q(ws, { status })}`)

export const confirmOccurrence = (ws: string, id: string, amount?: string) =>
  api<Occurrence>(`/api/recurring/occurrences/${id}/confirm?${q(ws)}`, {
    method: 'POST',
    body: JSON.stringify(amount != null ? { amount } : {}),
  })

export const skipOccurrence = (ws: string, id: string) =>
  api<Occurrence>(`/api/recurring/occurrences/${id}/skip?${q(ws)}`, { method: 'POST' })
