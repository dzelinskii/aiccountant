import { expect, test, vi } from 'vitest'
import type { CollectedAccount } from '../core/contract'
import type { AppAccount } from './app-accounts'
import type { CollectorConfig } from './config'
import { accountFingerprint } from './fingerprint'
import {
  askAboutAccounts,
  decideCandidates,
  linkableAppAccounts,
  parseSelection,
  type AskFns,
  type LinkPromptDeps,
} from './link-prompt'

const config: CollectorConfig = {
  apiBaseUrl: 'http://localhost:8000',
  apiToken: 'token',
  workspaceId: 'ws-1',
  days: 30,
  bank: 'alfa',
}

function account(id: string, extra: Partial<CollectedAccount> = {}): CollectedAccount {
  return {
    id,
    name: `Счёт ${id}`,
    type: 'CURRENT',
    currency: 'RUB',
    balance: null,
    creditLimit: null,
    cardMasks: [],
    ...extra,
  }
}

// ---- decideCandidates -------------------------------------------------

test('без терминала решение — молчать, даже если есть что предложить', () => {
  const decision = decideCandidates([account('a'), account('b')], 'alfa', new Map(), new Set(), false)
  expect(decision).toEqual({ kind: 'skip', unboundCount: 2 })
})

test('ничего не привязано — предлагаются все непривязанные, включая ранее отклонённые', () => {
  const declined = new Set([accountFingerprint('alfa', 'a')])
  const decision = decideCandidates([account('a'), account('b')], 'alfa', new Map(), declined, true)
  expect(decision).toEqual({ kind: 'ask', candidates: [account('a'), account('b')] })
})

test('что-то уже привязано — новый (не отклонённый) счёт всё равно предлагается', () => {
  // дефект «спрашивать только при нулевых привязках» ловится этим тестом:
  // при linked.size > 0 счета всё равно должны предлагаться, если они не в declined
  const linked = new Map([['linked-1', 'app-1']])
  const decision = decideCandidates([account('linked-1'), account('new-1')], 'alfa', linked, new Set(), true)
  expect(decision).toEqual({ kind: 'ask', candidates: [account('new-1')] })
})

test('что-то привязано — про отклонённый счёт второй раз не спрашивают', () => {
  const linked = new Map([['linked-1', 'app-1']])
  const declined = new Set([accountFingerprint('alfa', 'declined-1')])
  const decision = decideCandidates([account('linked-1'), account('declined-1')], 'alfa', linked, declined, true)
  expect(decision).toEqual({ kind: 'skip', unboundCount: 1 })
})

test('спрашивать нечего — решение молчать со счётчиком непривязанных', () => {
  const linked = new Map([
    ['a', 'app-a'],
    ['b', 'app-b'],
  ])
  const decision = decideCandidates([account('a'), account('b')], 'alfa', linked, new Set(), true)
  expect(decision).toEqual({ kind: 'skip', unboundCount: 0 })
})

// ---- linkableAppAccounts -----------------------------------------------

test('предлагаются только непривязанные счета приложения', () => {
  // дефект «показывать в списке привязки уже привязанные счета» ловится этим тестом
  const accounts: AppAccount[] = [
    { id: 'a1', name: 'Карта', isBankLinked: true },
    { id: 'a2', name: 'Копилка', isBankLinked: false },
  ]
  expect(linkableAppAccounts(accounts)).toEqual([{ id: 'a2', name: 'Копилка', isBankLinked: false }])
})

// ---- parseSelection ------------------------------------------------------

test('выбор двух из трёх', () => {
  expect(parseSelection('1,3', 3)).toEqual([0, 2])
})

test('пустой ответ — ни один счёт', () => {
  expect(parseSelection('', 3)).toEqual([])
})

test('повторяющийся номер не размножается', () => {
  expect(parseSelection('1,1,2', 3)).toEqual([0, 1])
})

test('неразбираемый ввод — null, а не исключение', () => {
  expect(parseSelection('abc', 3)).toBeNull()
  expect(parseSelection('1;2', 3)).toBeNull()
})

test('номер вне диапазона — null', () => {
  expect(parseSelection('0', 3)).toBeNull()
  expect(parseSelection('4', 3)).toBeNull()
})

// ---- askAboutAccounts ----------------------------------------------------

function fakeAsk(answers: string[]): AskFns {
  const printed: string[] = []
  const queue = [...answers]
  return {
    ask: async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('в тесте кончились заготовленные ответы')
      return next
    },
    print: (line) => printed.push(line),
  }
}

function fakeDeps(overrides: Partial<LinkPromptDeps> = {}): LinkPromptDeps {
  return {
    fetchAppAccounts: vi.fn(async () => {
      throw new Error('fetchAppAccounts не должен вызываться в этом тесте')
    }),
    createAppAccount: vi.fn(async () => {
      throw new Error('createAppAccount не должен вызываться в этом тесте')
    }),
    linkAppAccount: vi.fn(async () => {
      throw new Error('linkAppAccount не должен вызываться в этом тесте')
    }),
    ...overrides,
  }
}

test('пустой ответ отправляет все предложенные счета в отклонённые', async () => {
  const candidates = [account('a'), account('b')]
  const deps = fakeDeps()

  const result = await askAboutAccounts(config, 'alfa', candidates, fakeAsk(['']), deps)

  expect(result.declined).toEqual([accountFingerprint('alfa', 'a'), accountFingerprint('alfa', 'b')])
  expect(deps.fetchAppAccounts).not.toHaveBeenCalled()
})

test('неразбираемый ввод переспрашивает, а не падает', async () => {
  const candidates = [account('a'), account('b')]
  const deps = fakeDeps()

  const result = await askAboutAccounts(config, 'alfa', candidates, fakeAsk(['ерунда', '5', '']), deps)

  expect(result.declined).toEqual([accountFingerprint('alfa', 'a'), accountFingerprint('alfa', 'b')])
})

test('выбор двух из трёх: один привязывается к существующему счёту, второй заводится новым', async () => {
  const candidates = [account('a'), account('b'), account('c', { currency: null })]
  const existing: AppAccount = { id: 'app-existing', name: 'Старый счёт', isBankLinked: false }
  const deps = fakeDeps({
    fetchAppAccounts: vi.fn(async () => [existing, { id: 'app-linked', name: 'Уже привязан', isBankLinked: true }]),
    linkAppAccount: vi.fn(async () => ({ id: existing.id, name: existing.name, isBankLinked: true })),
    createAppAccount: vi.fn(async () => ({ id: 'app-new', name: 'Счёт c', isBankLinked: true })),
  })

  // выбраны счета 1 и 3 ("a" и "c"); для "a" — привязка к существующему (ответ "1"),
  // для "c" — новый счёт (ответ "0"), тип "1" (card), валюта не распознана — "USD"
  const result = await askAboutAccounts(config, 'alfa', candidates, fakeAsk(['1,3', '1', '0', '1', 'USD']), deps)

  expect(result.declined).toEqual([accountFingerprint('alfa', 'b')])
  expect(deps.linkAppAccount).toHaveBeenCalledWith(config, existing.id, {
    bankCode: 'alfa',
    fingerprint: accountFingerprint('alfa', 'a'),
  })
  expect(deps.createAppAccount).toHaveBeenCalledWith(config, {
    name: 'Счёт c',
    type: 'card',
    currency: 'USD',
    bankCode: 'alfa',
    fingerprint: accountFingerprint('alfa', 'c'),
  })
})

test('счетов приложения для привязки нет — новый счёт заводится без лишнего вопроса', async () => {
  const candidates = [account('a', { currency: 'RUB' })]
  const deps = fakeDeps({
    fetchAppAccounts: vi.fn(async () => []),
    createAppAccount: vi.fn(async () => ({ id: 'app-new', name: 'Счёт a', isBankLinked: true })),
  })

  // "1" — выбрать единственный счёт; дальше сразу тип (без вопроса про привязку,
  // потому что fetchAppAccounts вернул пустой список), валюта уже есть у банка
  await askAboutAccounts(config, 'alfa', candidates, fakeAsk(['1', '2']), deps)

  expect(deps.createAppAccount).toHaveBeenCalledWith(config, {
    name: 'Счёт a',
    type: 'cash',
    currency: 'RUB',
    bankCode: 'alfa',
    fingerprint: accountFingerprint('alfa', 'a'),
  })
})
