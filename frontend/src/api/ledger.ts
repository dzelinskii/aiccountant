import { api } from './client'

export interface Account {
  id: string
  name: string
  type: string
  currency: string
  is_archived: boolean
  balance: string
  // момент, на который остаток верен; null — остаток никто не сообщает,
  // счёт ведётся вручную
  reported_at: string | null
  // последние четыре цифры карт счёта; пусто у счетов без карт
  card_masks: string[]
}

export interface Category {
  id: string
  parent_id: string | null
  name: string
  kind: 'income' | 'expense'
}

export interface Counterparty {
  id: string
  name: string
  kind: 'person' | 'organization'
  category_id: string | null
  // нормализованные ключи правил, ведущих в контрагента: показываем именно их,
  // потому что сработает при импорте только такой ключ
  signatures: string[]
}

// подпись перевода, за которой ещё никого не закрепили; сумм здесь нет —
// для узнавания человека довольно счётчиков
export interface UnknownSignature {
  text: string
  operations: number
  sent: number
  received: number
}

export interface Transaction {
  id: string
  account_id: string
  category_id: string | null
  amount: string
  currency: string
  occurred_at: string
  merchant: string | null
  // имя контрагента, за которым закреплена банковская строка; null — никого
  // не закрепили. Приходит рядом с merchant, а не вместо неё
  counterparty_name: string | null
  note: string | null
  transfer_group_id: string | null
  operation_kind: string
  spending_override: boolean | null
  // считает бэкенд тем же правилом, что и запросы статистики: повторять его
  // здесь нельзя, иначе появится вторая реализация и разойдётся с первой
  counts_in_stats: boolean
  category_confirmed: boolean
  suggested_category_id: string | null
  category_confidence: string | null
}

export interface TransactionList {
  items: Transaction[]
  total: number
}

export interface Dashboard {
  accounts: {
    id: string
    name: string
    type: string
    currency: string
    balance: string
    reported_at: string | null
    card_masks: string[]
  }[]
  month_expenses: { category_id: string; category_name: string; total: string }[]
  recent: {
    id: string
    occurred_at: string
    amount: string
    currency: string
    account_name: string
    category_name: string | null
    merchant: string | null
    counts_in_stats: boolean
  }[]
}

const q = (ws: string, extra: Record<string, string | number> = {}) =>
  new URLSearchParams({ workspace_id: ws, ...Object.fromEntries(
    Object.entries(extra).map(([k, v]) => [k, String(v)]),
  ) }).toString()

export const getAccounts = (ws: string) => api<Account[]>(`/api/accounts?${q(ws)}`)

export const createAccount = (ws: string, body: { name: string; type: string; currency: string }) =>
  api<Account>(`/api/accounts?${q(ws)}`, { method: 'POST', body: JSON.stringify(body) })

// balance — строкой, как и остальные деньги: через float точность теряется.
// Счёт с сообщённым остатком бэкенд править не даёт и отвечает 409
export const updateAccount = (
  ws: string, id: string, body: { name?: string; is_archived?: boolean; balance?: string },
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

// null — сброс решения: дальше снова решает правило по виду операции
export const setSpendingOverride = (ws: string, id: string, value: boolean | null) =>
  api<Transaction>(`/api/transactions/${id}?${q(ws)}`, {
    method: 'PATCH',
    body: JSON.stringify({ spending_override: value }),
  })

export const deleteTransaction = (ws: string, id: string) =>
  api<void>(`/api/transactions/${id}?${q(ws)}`, { method: 'DELETE' })

export const getDashboard = (ws: string) => api<Dashboard>(`/api/dashboard?${q(ws)}`)

export const dismissSuggestion = (ws: string, id: string) =>
  api<Transaction>(`/api/transactions/${id}/dismiss-suggestion?${q(ws)}`, { method: 'POST' })

export const categorizeUncategorized = (ws: string) =>
  api<{ status: string }>(`/api/transactions/categorize?${q(ws)}`, { method: 'POST' })

// сколько ещё операций без категории описаны так же, как эта
export const getSimilarUncategorized = (ws: string, id: string) =>
  api<{ count: number }>(`/api/transactions/${id}/similar-uncategorized?${q(ws)}`)

export const applyCategoryToSimilar = (ws: string, id: string) =>
  api<{ applied: number }>(`/api/transactions/${id}/apply-category-to-similar?${q(ws)}`, {
    method: 'POST',
  })

export const getCounterparties = (ws: string) =>
  api<Counterparty[]>(`/api/counterparties?${q(ws)}`)

// подписи ложатся правилами одной транзакцией с контрагентом: занятая подпись
// отвечает 409, и контрагента при этом не остаётся
export const createCounterparty = (
  ws: string,
  body: { name: string; kind: string; category_id?: string | null; signatures: string[] },
) => api<Counterparty>(`/api/counterparties?${q(ws)}`, {
  method: 'POST',
  body: JSON.stringify(body),
})

// category_id: null — снять категорию, а не «поле не прислали»; бэкенд различает
// их по факту присутствия ключа, поэтому не подставляем его без надобности
export const updateCounterparty = (
  ws: string, id: string, body: { name?: string; category_id?: string | null },
) => api<Counterparty>(`/api/counterparties/${id}?${q(ws)}`, {
  method: 'PATCH',
  body: JSON.stringify(body),
})

// удаление уносит подписи контрагента: освобождённые снова станут неопознанными
export const deleteCounterparty = (ws: string, id: string) =>
  api<void>(`/api/counterparties/${id}?${q(ws)}`, { method: 'DELETE' })

// сколько операций без категории подписаны этим контрагентом
export const getCounterpartyUncategorized = (ws: string, id: string) =>
  api<{ count: number }>(`/api/counterparties/${id}/uncategorized?${q(ws)}`)

export const applyCounterpartyCategory = (ws: string, id: string) =>
  api<{ applied: number }>(`/api/counterparties/${id}/apply-category?${q(ws)}`, {
    method: 'POST',
  })

export const getUnknownSignatures = (ws: string) =>
  api<UnknownSignature[]>(`/api/counterparties/unknown-signatures?${q(ws)}`)
