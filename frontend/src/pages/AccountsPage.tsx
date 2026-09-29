import { Alert, Badge, Button, Card, Group, Modal, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useDisclosure } from '@mantine/hooks'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  createAccount,
  getAccounts,
  getBanks,
  getDiscovered,
  linkAccount,
  updateAccount,
  type Account,
  type DiscoveredAccount,
} from '../api/ledger'
import { AccountBalance } from '../components/AccountBalance'
import { ACCOUNT_TYPES, accountLabel, groupAccountsByBank } from '../lib/account'
import { formatMoney } from '../lib/money'
import { useWorkspaceStore } from '../store/workspace'

export function AccountsPage() {
  const ws = useWorkspaceStore((s) => s.workspaceId)!
  const queryClient = useQueryClient()
  const [opened, { open, close }] = useDisclosure(false)
  const [editing, setEditing] = useState<Account | null>(null)
  const [linkOpened, { open: openLink, close: closeLink }] = useDisclosure(false)
  const [linkTarget, setLinkTarget] = useState<DiscoveredAccount | null>(null)
  const [linkAccountId, setLinkAccountId] = useState<string | null>(null)

  const { data: accounts } = useQuery({ queryKey: ['accounts', ws], queryFn: () => getAccounts(ws) })
  const { data: banks } = useQuery({ queryKey: ['banks'], queryFn: getBanks })
  const { data: discovered } = useQuery({
    queryKey: ['discovered', ws],
    queryFn: () => getDiscovered(ws),
  })
  // выбирать при привязке можно только из непривязанных — привязанный счёт
  // уже отвечает на вопрос «куда слать операции», второй ответ не нужен
  const unlinkedAccounts = (accounts ?? []).filter((a) => !a.is_bank_linked)

  const form = useForm({
    initialValues: {
      name: '', type: 'card', currency: 'RUB', balance: '',
      bank_code: null as string | null, bank_account_fingerprint: '',
    },
    validate: { name: (v) => (v.trim() ? null : 'Введите название') },
  })

  const createMut = useMutation({
    mutationFn: (v: {
      name: string
      type: string
      currency: string
      bank_code?: string | null
      bank_account_fingerprint?: string
    }) => createAccount(ws, v),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      await queryClient.invalidateQueries({ queryKey: ['discovered', ws] })
      close()
      form.reset()
    },
  })
  const updateMut = useMutation({
    mutationFn: (v: { id: string; name?: string; is_archived?: boolean; balance?: string }) =>
      updateAccount(ws, v.id, { name: v.name, is_archived: v.is_archived, balance: v.balance }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      close()
      setEditing(null)
    },
  })
  const linkMut = useMutation({
    mutationFn: (v: { id: string; bank_code: string; bank_account_fingerprint: string }) =>
      linkAccount(ws, v.id, { bank_code: v.bank_code, bank_account_fingerprint: v.bank_account_fingerprint }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', ws] })
      await queryClient.invalidateQueries({ queryKey: ['discovered', ws] })
      closeLink()
      setLinkTarget(null)
      setLinkAccountId(null)
    },
  })

  const openCreate = () => {
    setEditing(null)
    updateMut.reset()
    form.setValues({
      name: '', type: 'card', currency: 'RUB', balance: '',
      bank_code: null, bank_account_fingerprint: '',
    })
    open()
  }
  const openEdit = (a: Account) => {
    setEditing(a)
    updateMut.reset()
    form.setValues({
      name: a.name, type: a.type, currency: a.currency, balance: '',
      bank_code: a.bank_code, bank_account_fingerprint: '',
    })
    open()
  }
  const openFromDiscovered = (item: DiscoveredAccount) => {
    setEditing(null)
    updateMut.reset()
    // имя и валюту подставляем из банка, тип человек выбирает сам: банковского
    // типа счёта мы не принимаем — это слово банка
    form.setValues({
      name: item.name,
      type: 'card',
      currency: item.currency ?? 'RUB',
      balance: '',
      bank_code: item.bank_code,
      bank_account_fingerprint: item.fingerprint,
    })
    open()
  }
  const openLinkModal = (item: DiscoveredAccount) => {
    setLinkTarget(item)
    setLinkAccountId(null)
    linkMut.reset()
    openLink()
  }
  const submitLink = () => {
    if (!linkTarget || !linkAccountId) return
    linkMut.mutate({
      id: linkAccountId,
      bank_code: linkTarget.bank_code,
      bank_account_fingerprint: linkTarget.fingerprint,
    })
  }

  const submit = (v: {
    name: string
    type: string
    currency: string
    balance: string
    bank_code: string | null
    bank_account_fingerprint: string
  }) => {
    if (!editing) {
      createMut.mutate({
        name: v.name,
        type: v.type,
        currency: v.currency,
        bank_code: v.bank_code,
        bank_account_fingerprint: v.bank_account_fingerprint || undefined,
      })
      return
    }
    // по-русски разделитель — запятая, а бэкенд ждёт точку: осмысленный ввод не
    // должен упираться в 422. Пустое поле — «не трогать»: правку остатка человек
    // делает не каждый раз, когда переименовывает счёт
    const balance = v.balance.trim().replace(',', '.')
    updateMut.mutate({ id: editing.id, name: v.name, balance: balance || undefined })
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Счета</Title>
        <Button onClick={openCreate}>Добавить счёт</Button>
      </Group>

      {groupAccountsByBank(accounts ?? [], banks ?? []).map((group) => (
        <Stack key={group.key} gap="xs">
          <Title order={4}>{group.title}</Title>
          {group.accounts.map((a) => (
            <Card key={a.id} withBorder>
              <Group justify="space-between">
                <div>
                  <Group gap="xs">
                    <Text fw={500}>{a.name}</Text>
                    {a.is_archived && <Badge color="gray">в архиве</Badge>}
                  </Group>
                  {accountLabel(a) && (
                    <Text c="dimmed" size="sm">{accountLabel(a)}</Text>
                  )}
                </div>
                <Group>
                  <AccountBalance account={a} align="right" size="md" />
                  <Button variant="light" size="xs" onClick={() => openEdit(a)}>Изменить</Button>
                </Group>
              </Group>
            </Card>
          ))}
        </Stack>
      ))}

      {discovered && discovered.length > 0 && (
        <Stack gap="xs">
          <Title order={4}>Есть в банке, но не ведётся</Title>
          {discovered.map((item) => (
            <Card key={item.fingerprint} withBorder>
              <Group justify="space-between">
                <div>
                  <Text fw={500}>{item.name}</Text>
                  <Text c="dimmed" size="sm">{item.bank_name}</Text>
                  {item.card_masks.length > 0 && (
                    <Text c="dimmed" size="sm">
                      {item.card_masks.map((m) => `•• ${m}`).join(', ')}
                    </Text>
                  )}
                </div>
                <Group>
                  {item.balance && item.currency && (
                    <Text fw={700}>{formatMoney(item.balance, item.currency)}</Text>
                  )}
                  {unlinkedAccounts.length > 0 && (
                    <Button variant="default" size="xs" onClick={() => openLinkModal(item)}>
                      Это мой счёт
                    </Button>
                  )}
                  <Button variant="light" size="xs" onClick={() => openFromDiscovered(item)}>
                    Завести счёт
                  </Button>
                </Group>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      <Modal opened={opened} onClose={close} title={editing ? 'Счёт' : 'Новый счёт'}>
        <form onSubmit={form.onSubmit(submit)}>
          <TextInput label="Название" {...form.getInputProps('name')} />
          <Select label="Тип" data={ACCOUNT_TYPES} mt="sm" disabled={!!editing} {...form.getInputProps('type')} />
          <TextInput label="Валюта" mt="sm" disabled={!!editing} {...form.getInputProps('currency')} />
          {!editing && !form.values.bank_account_fingerprint && (
            <Select
              label="Банк"
              placeholder="Без банка"
              clearable
              mt="sm"
              data={(banks ?? []).map((b) => ({ value: b.code, label: b.name }))}
              {...form.getInputProps('bank_code')}
            />
          )}
          {/* остаток от источника перезапишет следующий сбор — править его бессмысленно */}
          {editing && editing.reported_at === null && (
            <TextInput
              label="Остаток"
              mt="sm"
              placeholder="например 4900.00"
              description={`Сейчас ${formatMoney(editing.balance, editing.currency)}`}
              {...form.getInputProps('balance')}
            />
          )}
          {editing && (
            <Switch
              label="В архиве"
              mt="md"
              checked={editing.is_archived}
              onChange={(e) =>
                updateMut.mutate({ id: editing.id, is_archived: e.currentTarget.checked })
              }
            />
          )}
          {updateMut.isError && (
            <Alert color="red" mt="md">{updateMut.error.message}</Alert>
          )}
          <Button type="submit" mt="lg" fullWidth loading={createMut.isPending || updateMut.isPending}>
            Сохранить
          </Button>
        </form>
      </Modal>

      <Modal opened={linkOpened} onClose={closeLink} title="Привязать счёт">
        <Select
          label="Счёт приложения"
          placeholder="Выберите счёт"
          data={unlinkedAccounts.map((a) => ({ value: a.id, label: a.name }))}
          value={linkAccountId}
          onChange={setLinkAccountId}
        />
        {linkMut.isError && (
          <Alert color="red" mt="md">{linkMut.error.message}</Alert>
        )}
        <Button
          mt="lg"
          fullWidth
          disabled={!linkAccountId}
          loading={linkMut.isPending}
          onClick={submitLink}
        >
          Привязать
        </Button>
      </Modal>
    </Stack>
  )
}
