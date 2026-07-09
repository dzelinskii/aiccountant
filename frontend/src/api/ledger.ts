import { api } from './client'

export interface Account {
  id: string
  name: string
  type: string
  currency: string
  is_archived: boolean
  balance: string
}

export interface Category {
  id: string
  parent_id: string | null
  name: string
  kind: 'income' | 'expense'
}

export interface Transaction {
  id: string
  account_id: string
  category_id: string | null
  amount: string
  currency: string
  occurred_at: string
  merchant: string | null
  note: string | null
  transfer_group_id: string | null
  category_confirmed: boolean
  suggested_category_id: string | null
  category_confidence: string | null
}

export interface TransactionList {
  items: Transaction[]
  total: number
}

export interface Dashboard {
  accounts: { id: string; name: string; currency: string; balance: string }[]
  month_expenses: { category_id: string; category_name: string; total: string }[]
  recent: {
    id: string
    occurred_at: string
    amount: string
    currency: string
    account_name: string
    category_name: string | null
    merchant: string | null
    is_transfer: boolean
  }[]
}

const q = (ws: string, extra: Record<string, string | number> = {}) =>
  new URLSearchParams({ workspace_id: ws, ...Object.fromEntries(
    Object.entries(extra).map(([k, v]) => [k, String(v)]),
  ) }).toString()

export const getAccounts = (ws: string) => api<Account[]>(`/api/accounts?${q(ws)}`)

export const createAccount = (ws: string, body: { name: string; type: string; currency: string }) =>
  api<Account>(`/api/accounts?${q(ws)}`, { method: 'POST', body: JSON.stringify(body) })

export const updateAccount = (
  ws: string, id: string, body: { name?: string; is_archived?: boolean },
) => api<Account>(`/api/accounts/${id}?${q(ws)}`, { method: 'PATCH', body: JSON.stringify(body) })

export const getCategories = (ws: string) => api<Category[]>(`/api/categories?${q(ws)}`)

export const createCategory = (
  ws: string, body: { name: string; kind: string; parent_id?: string | null },
) => api<Category>(`/api/categories?${q(ws)}`, { method: 'POST', body: JSON.stringify(body) })

export const updateCategory = (
  ws: string, id: string, body: { name?: string; parent_id?: string | null },
) => api<Category>(`/api/categories/${id}?${q(ws)}`, { method: 'PATCH', body: JSON.stringify(body) })

export const getTransactions = (
  ws: string, filters: Record<string, string | number> = {},
) => api<TransactionList>(`/api/transactions?${q(ws, filters)}`)

export const createTransaction = (
  ws: string,
  body: { account_id: string; category_id?: string; amount: string; occurred_at: string; merchant?: string; note?: string },
) => api<Transaction>(`/api/transactions?${q(ws)}`, { method: 'POST', body: JSON.stringify(body) })

export const createTransfer = (
  ws: string,
  body: { from_account_id: string; to_account_id: string; from_amount: string; to_amount: string; occurred_at: string; note?: string },
) => api<TransactionList>(`/api/transactions/transfer?${q(ws)}`, { method: 'POST', body: JSON.stringify(body) })

export const updateTransaction = (
  ws: string, id: string,
  body: { category_id?: string; amount?: string; occurred_at?: string; merchant?: string; note?: string },
) => api<Transaction>(`/api/transactions/${id}?${q(ws)}`, { method: 'PATCH', body: JSON.stringify(body) })

export const deleteTransaction = (ws: string, id: string) =>
  api<void>(`/api/transactions/${id}?${q(ws)}`, { method: 'DELETE' })

export const getDashboard = (ws: string) => api<Dashboard>(`/api/dashboard?${q(ws)}`)

export const dismissSuggestion = (ws: string, id: string) =>
  api<Transaction>(`/api/transactions/${id}/dismiss-suggestion?${q(ws)}`, { method: 'POST' })

export const categorizeUncategorized = (ws: string) =>
  api<{ status: string }>(`/api/transactions/categorize?${q(ws)}`, { method: 'POST' })
