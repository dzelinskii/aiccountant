import { Alert, Anchor, Button, Card, Group, Stack, Text, Title } from '@mantine/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BANK_NAMES, accountsWord, type AccountResult } from 'aiccountant-collector/src/app'
import type { Bank } from '../api/ledger'
import { getAccounts, getBanks } from '../api/ledger'
import {
  collectAll,
  collectOne,
  forgetAccess,
  useCollectStore,
  type BankState,
  type BankStates,
} from '../store/collect'
import { useWorkspaceStore } from '../store/workspace'

const NO_STATES: BankStates = {}

const SESSION_TEXT = {
  stored: 'Сессия: из хранилища',
  login: 'Сессия: свежий вход',
} as const

// импорт ждёт решения на экране «Импорт»; закрытый приложением сразу там уже не виден
const isWaiting = (result: AccountResult) => result.importId !== null && !result.importClosed

// импорт без операций ушёл ради остатка счёта: «собрано 0» про него соврало бы
const isBalanceOnly = (result: AccountResult) => result.collected === 0 && result.importClosed

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
            : isBalanceOnly(result)
              ? 'операций за период нет, остаток обновлён'
              : `собрано ${result.collected}`}
        {result.importClosed && !isBalanceOnly(result) && ' — новых операций нет'}
        {isWaiting(result) && (
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
      {result.notes.map((note) => (
        <Text key={note} size="xs" c="dimmed">{note}</Text>
      ))}
    </Stack>
  )
}

export function BanksPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  // селектор не подставляет пустой объект сам: новый объект на каждый вызов zustand
  // принял бы за изменение и перерисовывал бы экран без конца
  const states = useCollectStore((s) => s.byWorkspace[ws]) ?? NO_STATES
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

  const accountName = (id: string) => (accounts ?? []).find((a) => a.id === id)?.name ?? id

  // начатое «Точно забыть?» относилось к прежнему намерению — после сбора нажатие снова первое
  const dropConfirm = (codes: string[]) =>
    setConfirming((current) => (current !== null && codes.includes(current) ? null : current))

  const onCollect = (bank: Bank) => {
    dropConfirm([bank.code])
    void collectOne(queryClient, ws, bank)
  }

  const onCollectAll = () => {
    dropConfirm(linkable.map((bank) => bank.code))
    void collectAll(queryClient, ws, linkable)
  }

  const onForget = (bank: Bank) => {
    if (confirming !== bank.code) {
      setConfirming(bank.code)
      return
    }
    setConfirming(null)
    void forgetAccess(ws, bank)
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
          {passed.some(isWaiting) && (
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
        <Button onClick={onCollectAll} disabled={busy || linkable.length === 0}>
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
                    onClick={() => onCollect(bank)}
                    disabled={state.running}
                  >
                    Собрать
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    color="red"
                    onClick={() => onForget(bank)}
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
