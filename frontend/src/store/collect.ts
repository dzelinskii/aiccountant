import type { QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import {
  AppHttpError,
  BankSessionExpiredError,
  type AccountResult,
  type CollectSummary,
} from 'aiccountant-collector/src/app'
import type { Bank } from '../api/ledger'
import { collectFromApp, forgetBank } from '../desktop/collector-host'

// Итог — отчёт о последнем сборе сеанса, а не история: настоящий след сбора
// остаётся в импортах приложения. Живёт вне экрана «Банки», потому что сбор
// переживает уход с экрана, и его результат должен дойти до того, кто вернётся.
export interface BankState {
  running: boolean
  summary?: CollectSummary
  error?: string
  /** Счета, пройденные до смерти сессии банка: импорты по ним уже созданы. */
  partial?: AccountResult[]
}

export type BankStates = Record<string, BankState>

interface CollectState {
  /** Банки по рабочим пространствам: итог одного пространства не показывается в другом. */
  byWorkspace: Record<string, BankStates>
  setBank: (ws: string, code: string, state: BankState) => void
  setRunning: (ws: string, code: string, running: boolean) => void
  reset: () => void
}

export const useCollectStore = create<CollectState>((set) => ({
  byWorkspace: {},
  setBank: (ws, code, state) =>
    set((prev) => ({ byWorkspace: { ...prev.byWorkspace, [ws]: { ...prev.byWorkspace[ws], [code]: state } } })),
  // занятость меняется без потери итога: банк, ждущий очереди, показывает прежний итог
  setRunning: (ws, code, running) =>
    set((prev) => {
      const banks = prev.byWorkspace[ws] ?? {}
      return { byWorkspace: { ...prev.byWorkspace, [ws]: { ...banks, [code]: { ...banks[code], running } } } }
    }),
  reset: () => set({ byWorkspace: {} }),
}))

const SESSION_EXPIRED_TEXT = 'Сессия банка кончилась посреди сбора — нажмите «Собрать», чтобы войти заново'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// сбор мог создать импорты и завести счета — экраны, которые их показывают,
// должны перечитать данные
function refreshAfterCollect(queryClient: QueryClient, ws: string) {
  void queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
  void queryClient.invalidateQueries({ queryKey: ['discovered', ws] })
  void queryClient.invalidateQueries({ queryKey: ['pending-imports', ws] })
}

/** Возвращает true, если приложение отказало во входе (401): дальше собирать нечем. */
export async function collectOne(queryClient: QueryClient, ws: string, bank: Bank): Promise<boolean> {
  const { setBank } = useCollectStore.getState()
  setBank(ws, bank.code, { running: true })
  let next: BankState
  let unauthorized = false
  try {
    next = { running: false, summary: await collectFromApp(bank.code, ws) }
  } catch (error) {
    // 401 от приложения — токен приложения умер: AuthGuard уведёт на вход, когда «me» перечитается
    if (error instanceof AppHttpError && error.status === 401) {
      unauthorized = true
      void queryClient.invalidateQueries({ queryKey: ['me'] })
    }
    next =
      error instanceof BankSessionExpiredError
        ? { running: false, error: `${bank.name}: ${SESSION_EXPIRED_TEXT}`, partial: error.partial }
        : { running: false, error: `${bank.name}: ${errorText(error)}` }
  }
  setBank(ws, bank.code, next)
  refreshAfterCollect(queryClient, ws)
  return unauthorized
}

export async function collectAll(queryClient: QueryClient, ws: string, banks: Bank[]): Promise<void> {
  const { setRunning } = useCollectStore.getState()
  // банки помечаются занятыми сразу все: пока очередь идёт, их кнопки не должны
  // вклиниваться в неё
  for (const bank of banks) setRunning(ws, bank.code, true)
  for (const [index, bank] of banks.entries()) {
    if (!(await collectOne(queryClient, ws, bank))) continue
    // человека уводят на экран входа: сбор остальных банков мог бы открыть их окна входа
    // поверх него, а кнопки оставшихся не должны залипнуть занятыми
    for (const rest of banks.slice(index + 1)) setRunning(ws, rest.code, false)
    return
  }
}

export async function forgetAccess(ws: string, bank: Bank): Promise<void> {
  const { setBank } = useCollectStore.getState()
  setBank(ws, bank.code, { running: true })
  try {
    await forgetBank(bank.code)
    setBank(ws, bank.code, { running: false })
  } catch (error) {
    setBank(ws, bank.code, { running: false, error: `${bank.name}: ${errorText(error)}` })
  }
}
