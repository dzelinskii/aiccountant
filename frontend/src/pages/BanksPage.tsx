import { Alert, Anchor, Button, Card, Group, Stack, Text, Title } from '@mantine/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AppHttpError,
  BANK_NAMES,
  BankSessionExpiredError,
  accountsWord,
  type AccountResult,
  type CollectSummary,
} from 'aiccountant-collector/src/app'
import type { Bank } from '../api/ledger'
import { getAccounts, getBanks } from '../api/ledger'
import { collectFromApp, forgetBank } from '../desktop/collector-host'
import { useWorkspaceStore } from '../store/workspace'

// итог держится только в памяти экрана: это отчёт о последнем сборе сеанса,
// а не история — настоящий след сбора остаётся в импортах приложения
interface BankState {
  running: boolean
  summary?: CollectSummary
  error?: string
  /** Счета, пройденные до смерти сессии банка: импорты по ним уже созданы. */
  partial?: AccountResult[]
}

const SESSION_TEXT = {
  stored: 'Сессия: из хранилища',
  login: 'Сессия: свежий вход',
} as const

const SESSION_EXPIRED_TEXT = 'Сессия банка кончилась посреди сбора — нажмите «Собрать», чтобы войти заново'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function AccountLine({ result, name }: { result: AccountResult; name: string }) {
  const { counters } = result
  return (
    <Stack gap={0}>
      <Text size="sm">
        {name}:{' '}
        {result.error !== null
          ? result.error
          : result.importId === null
            ? 'операций за период нет'
            : `собрано ${result.collected}`}
        {result.importId !== null && (
          <>
            {' — '}
            <Anchor component={Link} to="/import" size="sm">импорт</Anchor>
          </>
        )}
      </Text>
      {counters.unknownKinds > 0 && (
        <Text size="xs" c="dimmed">вид операции не распознан у {counters.unknownKinds}</Text>
      )}
      {counters.missingHints > 0 && (
        <Text size="xs" c="dimmed">
          категория не определена у {counters.missingHints} трат из {counters.purchases}
        </Text>
      )}
      {counters.unrefinedIncome > 0 && (
        <Text size="xs" c="dimmed">приход не разобран у {counters.unrefinedIncome}</Text>
      )}
    </Stack>
  )
}

export function BanksPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [states, setStates] = useState<Record<string, BankState>>({})
  // банк, у которого «Забыть доступ» ждёт второго нажатия
  const [confirming, setConfirming] = useState<string | null>(null)

  const { data: banks } = useQuery({ queryKey: ['banks'], queryFn: getBanks })
  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })

  // банки с сервера включают и те, для которых плагина в коллекторе ещё нет
  const rows = (banks ?? []).filter((bank) => BANK_NAMES.includes(bank.code))
  const linkable = rows.filter((bank) =>
    (accounts ?? []).some((a) => a.bank_code === bank.code && a.is_bank_linked),
  )
  const busy = Object.values(states).some((s) => s.running)

  const setBank = (code: string, state: BankState) => setStates((prev) => ({ ...prev, [code]: state }))
  // занятость меняется без потери итога: банк, ждущий очереди, показывает прежний итог
  const setRunning = (code: string, running: boolean) =>
    setStates((prev) => ({ ...prev, [code]: { ...prev[code], running } }))

  const accountName = (id: string) => (accounts ?? []).find((a) => a.id === id)?.name ?? id

  // сбор мог создать импорты и завести счета — экраны, которые их показывают,
  // должны перечитать данные
  const refreshAfterCollect = () => {
    void queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
    void queryClient.invalidateQueries({ queryKey: ['discovered', ws] })
    void queryClient.invalidateQueries({ queryKey: ['pending-imports', ws] })
  }

  /** Возвращает true, если приложение отказало во входе (401): дальше собирать нечем. */
  const collectOne = async (bank: Bank): Promise<boolean> => {
    // начатое «Точно забыть?» относилось к прежнему намерению — после сбора нажатие снова первое
    setConfirming((current) => (current === bank.code ? null : current))
    setBank(bank.code, { running: true })
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
    setBank(bank.code, next)
    refreshAfterCollect()
    return unauthorized
  }

  const collectAll = async () => {
    // банки помечаются занятыми сразу все: пока очередь идёт, их кнопки не должны
    // вклиниваться в неё
    for (const bank of linkable) setRunning(bank.code, true)
    for (const [index, bank] of linkable.entries()) {
      if (!(await collectOne(bank))) continue
      // человека уводят на экран входа: сбор остальных банков мог бы открыть их окна входа
      // поверх него, а кнопки оставшихся не должны залипнуть занятыми
      for (const rest of linkable.slice(index + 1)) setRunning(rest.code, false)
      return
    }
  }

  const forget = async (bank: Bank) => {
    if (confirming !== bank.code) {
      setConfirming(bank.code)
      return
    }
    setConfirming(null)
    setBank(bank.code, { running: true })
    try {
      await forgetBank(bank.code)
      setBank(bank.code, { running: false })
    } catch (error) {
      setBank(bank.code, { running: false, error: `${bank.name}: ${errorText(error)}` })
    }
  }

  const renderAccounts = (results: AccountResult[]) =>
    results.map((result) => (
      <AccountLine key={result.appAccountId} result={result} name={accountName(result.appAccountId)} />
    ))

  const renderState = (state: BankState) => {
    if (state.error !== undefined) {
      const passed = state.partial ?? []
      return (
        <Stack gap="xs">
          <Alert color="red">{state.error}</Alert>
          {renderAccounts(passed)}
          {passed.some((r) => r.importId !== null) && (
            <Text size="sm">Созданные импорты уже ждут решения на экране «Импорт».</Text>
          )}
        </Stack>
      )
    }
    const { summary } = state
    if (summary === undefined) return null
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">{SESSION_TEXT[summary.session]}</Text>
        {summary.accounts.length === 0 ? (
          <Text size="sm">
            Ни один счёт банка не привязан. Привяжите их на экране{' '}
            <Anchor component={Link} to="/accounts" size="sm">«Счета»</Anchor>.
          </Text>
        ) : (
          renderAccounts(summary.accounts)
        )}
        {summary.unboundCount > 0 && summary.accounts.length > 0 && (
          <Text size="sm">
            В банке ещё {accountsWord(summary.unboundCount)} не ведётся. Привяжите их на экране{' '}
            <Anchor component={Link} to="/accounts" size="sm">«Счета»</Anchor>.
          </Text>
        )}
      </Stack>
    )
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Банки</Title>
        <Button onClick={() => void collectAll()} disabled={busy || linkable.length === 0}>
          Собрать всё
        </Button>
      </Group>
      {rows.map((bank) => {
        const state = states[bank.code] ?? { running: false }
        return (
          <Card key={bank.code} withBorder data-testid={`bank-${bank.code}`}>
            <Stack>
              <Group justify="space-between">
                <Text fw={600}>{bank.name}</Text>
                <Group gap="xs">
                  <Button
                    size="xs"
                    onClick={() => void collectOne(bank)}
                    disabled={state.running}
                  >
                    Собрать
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    color="red"
                    onClick={() => void forget(bank)}
                    disabled={state.running}
                  >
                    {confirming === bank.code ? 'Точно забыть?' : 'Забыть доступ'}
                  </Button>
                </Group>
              </Group>
              {renderState(state)}
            </Stack>
          </Card>
        )
      })}
    </Stack>
  )
}
