# Остаток кредитов наличными — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** долг по кредитам наличными Т-Банка и Альфа-Банка приезжает отрицательным остатком счёта и показывается «долг N ₽».

**Architecture:** общий помощник «долг из суммы» и пояснение в ядре коллектора; плагин Т-Банка берёт `debtAmount` у `CashLoan`; плагин Альфы спрашивает договоры `GET /api/v1/credit/info` и делает из действующих некарточных договоров счета; оболочка пускает новый адрес; экран пишет «долг» при отрицательном остатке. Бэкенд не меняется.

**Tech Stack:** TypeScript (collector, frontend — vitest, oxlint), Rust (desktop/src-tauri — cargo test).

Спека: `docs/superpowers/specs/2026-10-05-loan-balance-design.md` (§3, §4, §5, §6a).

---

## Правила исполнения

- Worktree `.claude/worktrees/loan-balance`, ветка `feature/loan-balance` (от `origin/main`). Основной каталог, стенд и базу владельца не трогать. Живые банки — только в задаче 7 и только с разрешения владельца.
- Порядок в задаче: тест → красный → реализация → зелёный → **коммит** → дефект из задачи → красный → `git checkout -- <файл>` → зелёный. Внося дефект, проверять по `git diff`, что он внесён (файлы бывают CRLF).
- Комментарии и коммиты по-русски, **без строк Co-Authored-By**.
- Деньги — строки; `Number`/`parseFloat` для сумм запрещены.
- Справочник — в той же задаче, что поведение, по строкам кода `файл:строка`.

### Команды проверки

| Где | Команда |
|---|---|
| `collector/` | `pnpm test && pnpm lint && pnpm build && pnpm reference` (после — `git status docs/reference/generated` пусто) |
| `frontend/` | `pnpm test && pnpm lint && pnpm build` |
| `desktop/src-tauri/` | `export PATH="$HOME/.cargo/bin:$PATH"; cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` (нужен собранный фронт: `pnpm --dir ../../frontend build`) |

Если `node_modules` нет — `pnpm install --frozen-lockfile` в пакете; затем убедиться, что `frontend/package.json` и lock содержат `link:../collector` (pnpm на Windows пишет обратный слэш).

---

## Карта файлов

- `collector/src/core/money.ts` — `+ debtFrom(value)`: −|value|.
- `collector/src/core/money.test.ts` — новый.
- `collector/src/core/account-notes.ts` — `+ loanBalanceMissing`.
- `collector/src/plugins/tbank/map.ts` — `CashLoan`: остаток и пояснение.
- `collector/src/plugins/tbank/map.test.ts` — тесты кредита.
- `collector/src/plugins/alfa/client.ts` — `+ CREDITS_PATH`.
- `collector/src/plugins/alfa/map.ts` — `+ toLoanAccounts`, `+ LOAN_ID_PREFIX`.
- `collector/src/plugins/alfa/map.test.ts` — тесты договоров.
- `collector/src/plugins/alfa/index.ts` — `fetchAccounts` с договорами, `fetchOperations` без истории у кредита.
- `collector/src/plugins/alfa/index.test.ts` — маршрут `credit/info`, тесты.
- `desktop/src-tauri/src/banks.rs` — адрес `GET /api/v1/credit/info` у Альфы и в `bank_lists_are_pinned`.
- `frontend/src/components/AccountBalance.tsx` и `.test.tsx` — «долг» у счёта без лимита.
- `docs/reference/collector.md`, `docs/backlog.md` — справочник и бэклог.

---

### Task 1: ядро — долг из суммы и пояснение «остаток кредита не получен»

**Files:**
- Modify: `collector/src/core/money.ts`
- Create: `collector/src/core/money.test.ts`
- Modify: `collector/src/core/account-notes.ts`

- [ ] **Step 1: тест**

```ts
// collector/src/core/money.test.ts
import { expect, test } from 'vitest'
import { debtFrom, subtractDecimal } from './money'

test('долг из отрицательной суммы — та же сумма', () => {
  expect(debtFrom('-472680.39')).toBe('-472680.39')
})

test('долг из положительной суммы — со знаком минус: у кредита своих денег не бывает', () => {
  expect(debtFrom('50000.00')).toBe('-50000.00')
})

test('нулевой долг — ноль без минуса', () => {
  expect(debtFrom('0.00')).toBe('0.00')
  expect(debtFrom('-0.00')).toBe('0.00')
})

test('не десятичное число — ошибка без значения в тексте', () => {
  expect(() => debtFrom('много')).toThrow(/не десятичное/)
  expect(() => debtFrom('1e5')).toThrow(/не десятичное/)
})

test('разность сумм сохраняет разряды', () => {
  expect(subtractDecimal('139999.53', '142000.00')).toBe('-2000.47')
})
```

- [ ] **Step 2: красный** — `pnpm test src/core/money.test.ts` → FAIL (`debtFrom` нет).

- [ ] **Step 3: реализация** — в `collector/src/core/money.ts` после `subtractDecimal`:

```ts
/**
 * Остаток счёта-кредита: модуль суммы со знаком минус. Знак из ответа банка не
 * берётся — у кредита собственных денег не бывает, а знак долга у банков
 * разный (у кредита наличными Т-Банка отрицательный, у кредитной карты
 * положительный), и угаданный неверно превратил бы долг в деньги на счёте.
 */
export function debtFrom(value: string): string {
  if (!DECIMAL.test(value)) throw new Error('Долг: значение не десятичное число')
  return subtractDecimal('0', value.startsWith('-') ? value.slice(1) : value)
}
```

`subtractDecimal('0', '0.00')` даёт `'0.00'` без минуса (`fromScaled` срезает «−0»).

В `collector/src/core/account-notes.ts` в `ACCOUNT_NOTES`:

```ts
  loanBalanceMissing: 'Остаток кредита не получен — в приложении он не обновится',
```

- [ ] **Step 4: зелёный** — `pnpm test src/core/money.test.ts` → PASS; `pnpm lint && pnpm build`.

- [ ] **Step 5: коммит**

```bash
git add collector/src/core
git commit -m "Ядро коллектора: долг из суммы и пояснение «остаток кредита не получен»"
```

- [ ] **Step 6: дефект** — в `debtFrom` вернуть `value` как есть → FAIL «долг из положительной суммы…». Откатить.

---

### Task 2: Т-Банк — остаток кредита наличными

**Files:**
- Modify: `collector/src/plugins/tbank/map.ts` (`toAccount` ~:83-92, `resolveBalance` ~:119-132)
- Modify: `collector/src/plugins/tbank/map.test.ts` (тест «кредит наличными остаётся без остатка» ~:576 заменить)
- Modify: `docs/reference/collector.md` (~:327-332)

- [ ] **Step 1: тесты** — заменить тест «кредит наличными остаётся без остатка — moneyAmount у него нет» на:

```ts
const cashLoan = (debtAmount: unknown): Record<string, unknown> => ({
  id: 'acc-loan',
  name: 'Кредит наличными',
  accountType: 'CashLoan',
  currency: { strCode: '643' },
  creditAmount: { value: '600000.00' },
  maxRepaymentAmount: { value: '473500.00' },
  ...(debtAmount === undefined ? {} : { debtAmount }),
})

test('остаток кредита наличными — долг из debtAmount, со знаком минус', () => {
  const [account] = toAccounts([cashLoan({ value: '-471953.00' })])
  expect(account?.balance).toBe('-471953.00')
  expect(account?.creditLimit).toBeNull()
  expect(account?.notes).toEqual([])
})

test('долг кредита пришёл положительным — остаток всё равно с минусом', () => {
  const [account] = toAccounts([cashLoan({ value: '471953.00' })])
  expect(account?.balance).toBe('-471953.00')
})

test('у кредита без debtAmount остаток пуст и есть пояснение', () => {
  const [account] = toAccounts([cashLoan(undefined)])
  expect(account?.balance).toBeNull()
  expect(account?.notes).toEqual([ACCOUNT_NOTES.loanBalanceMissing])
})

test('debtAmount не строкой — остаток пуст и есть пояснение, а не остановка сбора', () => {
  const [account] = toAccounts([cashLoan({ value: 471953 })])
  expect(account?.balance).toBeNull()
  expect(account?.notes).toEqual([ACCOUNT_NOTES.loanBalanceMissing])
})

test('«Долями» без покупок остаётся без остатка и без пояснения', () => {
  const [account] = toAccounts([{ id: 'acc-bnpl', name: 'Долями', accountType: 'BNPL', approvedLimit: { value: '15000.00' }, availableLimit: { value: '15000.00' } }])
  expect(account?.balance).toBeNull()
  expect(account?.notes).toEqual([])
})
```

Импорт в начало файла: `import { ACCOUNT_NOTES } from '../../core/account-notes'`.

- [ ] **Step 2: красный** — `pnpm test src/plugins/tbank/map.test.ts` → FAIL (остаток `null`).

- [ ] **Step 3: реализация** в `collector/src/plugins/tbank/map.ts`:

Импорты: `import { ACCOUNT_NOTES, type AccountNote } from '../../core/account-notes'` и `import { debtFrom, subtractDecimal } from '../../core/money'`.

Константа рядом с `CREDIT_CARD_ACCOUNT_TYPE`:

```ts
// Кредит наличными. Остаток — долг из debtAmount: тело долга без набежавших
// процентов, ровно то число, что кабинет банка показывает главным на странице
// кредита (замер 2026-10-05, спека 2026-10-05-loan-balance-design.md §5)
const CASH_LOAN_ACCOUNT_TYPE = 'cashloan'

function isCashLoan(item: Record<string, unknown>): boolean {
  return (getStr(item, 'accountType') ?? '').toLowerCase() === CASH_LOAN_ACCOUNT_TYPE
}

function loanBalance(item: Record<string, unknown>): string | null {
  const debt = getRecord(item, 'debtAmount')
  const value = debt ? toAmountString(debt['value']) : undefined
  return value === undefined ? null : debtFrom(value)
}
```

В `resolveBalance` первой строкой:

```ts
  if (isCashLoan(item)) return loanBalance(item)
```

В `toAccount` вместо `balance: resolveBalance(item)` и `notes: []`:

```ts
  const balance = resolveBalance(item)
  return {
    id,
    name: getStr(item, 'name') ?? '',
    type: getStr(item, 'accountType') ?? '',
    currency: resolveCurrency(getRecord(item, 'currency')),
    balance,
    creditLimit: resolveCreditLimit(item),
    cardMasks: resolveCardMasks(item),
    notes: accountNotes(item, balance),
  }
```

и функция:

```ts
// Кредит без долга в ответе: остаток не обновится, и человек должен узнать
// почему, а не гадать по старому числу
function accountNotes(item: Record<string, unknown>, balance: string | null): AccountNote[] {
  return isCashLoan(item) && balance === null ? [ACCOUNT_NOTES.loanBalanceMissing] : []
}
```

Поправить комментарии, которые теперь врут: у `CREDIT_CARD_ACCOUNT_TYPE` (~:95-98) — «CashLoan считается отдельно (CASH_LOAN_ACCOUNT_TYPE), у BNPL поля moneyAmount нет»; в докстринге `resolveCreditLimit` (~:148-150) — «У кредита наличными лимита нет (creditAmount — сумма выдачи), BNPL — лимиты без долга».

`debtFrom` бросает на недесятичной строке. `toAmountString` пропускает любую строку — недесятичная строка из банка уронит сбор. Чтобы остаток дополнял сбор, а не останавливал его (комментарий `resolveBalance`), в `loanBalance`:

```ts
  if (value === undefined || !/^-?\d+(\.\d+)?$/.test(value)) return null
  return debtFrom(value)
```

и тест:

```ts
test('debtAmount не числом — остаток пуст, сбор не падает', () => {
  const [account] = toAccounts([cashLoan({ value: 'много' })])
  expect(account?.balance).toBeNull()
  expect(account?.notes).toEqual([ACCOUNT_NOTES.loanBalanceMissing])
})
```

- [ ] **Step 4: справочник** — в `docs/reference/collector.md` у пункта Т-Банка (~:327-332) заменить «Прочие кредитные виды (`CashLoan`, `BNPL`) пересчёт не трогает — …» на: у кредита наличными (`CashLoan`) остаток — долг из `debtAmount`, модуль со знаком минус (`plugins/tbank/map.ts:<строка loanBalance>`, `core/money.ts:<строка debtFrom>`); долга нет в ответе — остаток пуст и пояснение «остаток кредита не получен» (`plugins/tbank/map.ts:<строка accountNotes>`); у «Долями» (`BNPL`) остатка нет. И ~:369 — «`CashLoan` и `BNPL` не попадают сюда намеренно…» дополнить: у кредита наличными лимита нет, `creditAmount` — сумма выдачи. Номера строк — по коду после правки.

- [ ] **Step 5: зелёный** — проверки `collector/` целиком.

- [ ] **Step 6: коммит**

```bash
git add collector/src/plugins/tbank docs/reference/collector.md
git commit -m "Т-Банк: остаток кредита наличными — долг из debtAmount"
```

- [ ] **Step 7: дефекты** (по одному, откат):
  - `isCashLoan` всегда `false` → FAIL «остаток кредита наличными…»;
  - `loanBalance` возвращает `value` без `debtFrom` → FAIL «долг кредита пришёл положительным…»;
  - `accountNotes` всегда `[]` → FAIL «у кредита без debtAmount…».

---

### Task 3: оболочка — адрес договоров Альфы

**Files:**
- Modify: `desktop/src-tauri/src/banks.rs` (список `alfa` ~:67-71 и `bank_lists_are_pinned` ~:259-263)

- [ ] **Step 1:** в литерал `alfa.allowed` и в ожидаемый список теста добавить `("GET", "/api/v1/credit/info")` — после `("GET", "/api/v1/cards/masked-cards")`.

- [ ] **Step 2: проверки** `desktop/src-tauri/` — зелёные. Тест `shell-allowlist.test.ts` коллектора в этот момент **красный** («каждая пара списка оболочки вызывается плагином» для `alfa`) — это ожидаемо и чинится задачей 4. Коммит отдельный, чтобы задача 4 начиналась с красного сторожа:

```bash
git add desktop/src-tauri/src/banks.rs
git commit -m "Оболочка пускает к Альфе запрос кредитных договоров"
```

- [ ] **Step 3: дефект** — убрать строку только из литерала `BANKS` → FAIL `bank_lists_are_pinned`. Откатить.

---

### Task 4: Альфа — кредиты из договоров

**Files:**
- Modify: `collector/src/plugins/alfa/client.ts`
- Modify: `collector/src/plugins/alfa/map.ts`
- Modify: `collector/src/plugins/alfa/map.test.ts`
- Modify: `collector/src/plugins/alfa/index.ts`
- Modify: `collector/src/plugins/alfa/index.test.ts`
- Modify: `docs/reference/collector.md`

- [ ] **Step 1: тесты разбора** — в `collector/src/plugins/alfa/map.test.ts`:

```ts
import { ACCOUNT_NOTES } from '../../core/account-notes'
import { LOAN_ID_PREFIX, toLoanAccounts } from './map'

const contract = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountNumber: '40817810000000002905',
  agreementNumber: 'PIL123456',
  clientCreditName: 'Кредит наличными',
  productGroup: 'PIL',
  contractStatus: 'A',
  principal: { value: '47268039', minorUnits: '100', currency: 'RUR' },
  ...overrides,
})

test('действующий кредит — счёт с долгом из principal, по номеру договора', () => {
  const [loan] = toLoanAccounts([contract()])
  expect(loan).toEqual({
    id: `${LOAN_ID_PREFIX}PIL123456`,
    name: 'Кредит наличными',
    type: 'PIL',
    currency: 'RUB',
    balance: '-472680.39',
    creditLimit: null,
    cardMasks: [],
    notes: [],
  })
})

test('идентификатор кредита не совпадает с номером текущего счёта платежей', () => {
  const [loan] = toLoanAccounts([contract()])
  expect(loan?.id).not.toBe('40817810000000002905')
})

test('кредитные карты из договоров не берутся — они уже есть в списке счетов', () => {
  expect(toLoanAccounts([contract({ productGroup: 'CCD' })])).toEqual([])
})

test('недействующий договор не берётся', () => {
  expect(toLoanAccounts([contract({ contractStatus: 'N' })])).toEqual([])
})

test('незнакомая группа кредита проходит тем же правилом', () => {
  expect(toLoanAccounts([contract({ productGroup: 'MORTGAGE', agreementNumber: 'M1' })])).toHaveLength(1)
})

test('principal не разобрать — остаток пуст и пояснение', () => {
  const [loan] = toLoanAccounts([contract({ principal: { value: 'много', minorUnits: '100', currency: 'RUR' } })])
  expect(loan?.balance).toBeNull()
  expect(loan?.notes).toEqual([ACCOUNT_NOTES.loanBalanceMissing])
})

test('договор без номера пропускается — без него у счёта нет устойчивого идентификатора', () => {
  expect(toLoanAccounts([contract({ agreementNumber: undefined })])).toEqual([])
})
```

- [ ] **Step 2: красный** — `pnpm test src/plugins/alfa/map.test.ts` → FAIL (`toLoanAccounts` нет).

- [ ] **Step 3: разбор** — в `collector/src/plugins/alfa/map.ts` (импорты `ACCOUNT_NOTES`, `debtFrom`):

```ts
/**
 * Кредиты Альфы живут не в списке счетов, а в договорах (`/api/v1/credit/info`,
 * спека 2026-10-05-loan-balance-design.md §6a). Счётом становится действующий
 * договор, кроме кредитной карты: карты уже приходят списком счетов.
 *
 * Идентификатор — номер договора с приставкой: accountNumber договора — это
 * текущий счёт, с которого списываются платежи, и с ним отпечаток кредита
 * совпал бы с отпечатком этого счёта. Приставка же говорит fetchOperations, что
 * истории у такого счёта нет.
 */
export const LOAN_ID_PREFIX = 'loan:'
const CARD_PRODUCT_GROUP = 'CCD'
const ACTIVE_CONTRACT = 'A'

export function toLoanAccounts(contracts: readonly unknown[]): CollectedAccount[] {
  const loans: CollectedAccount[] = []
  for (const item of contracts) {
    if (!isRecord(item)) continue
    if (getStr(item, 'productGroup') === CARD_PRODUCT_GROUP) continue
    if (getStr(item, 'contractStatus') !== ACTIVE_CONTRACT) continue
    const agreement = getStr(item, 'agreementNumber')
    if (!agreement) continue
    const principal = getRecord(item, 'principal')
    const balance = loanBalance(principal)
    loans.push({
      id: `${LOAN_ID_PREFIX}${agreement}`,
      name: getStr(item, 'clientCreditName') ?? '',
      type: getStr(item, 'productGroup') ?? '',
      currency: blockCurrency(principal),
      balance,
      creditLimit: null,
      cardMasks: [],
      notes: balance === null ? [ACCOUNT_NOTES.loanBalanceMissing] : [],
    })
  }
  return loans
}

// Остаток кредита — тело долга (principal): кабинет показывает его «Остатком
// задолженности»; проценты лежат отдельно. Негодная сумма — пустой остаток, а
// не остановка сбора: список счетов справочный
function loanBalance(principal: Record<string, unknown> | undefined): string | null {
  try {
    const value = blockValue(principal)
    return value === null ? null : debtFrom(value)
  } catch {
    return null
  }
}
```

`blockValue` и `blockCurrency` уже есть в файле. Тест «principal не разобрать» проходит через `shiftByMinorUnits`, который бросает на недесятичном — перехват выше превращает это в пустой остаток.

- [ ] **Step 4: зелёный** для `map.test.ts`.

- [ ] **Step 5: тесты плагина** — в `collector/src/plugins/alfa/index.test.ts`:

В `Routes` добавить `credits?: { status: number; body?: string }`, в маршрутизатор:

```ts
      if (path === '/api/v1/credit/info') {
        const r = routes.credits ?? { status: 200, body: '{"contracts":[]}' }
        return { status: r.status, ok: r.status < 300, text: async () => r.body ?? '{}' }
      }
```

Тесты:

```ts
const LOAN_CONTRACTS =
  '{"contracts":[{"accountNumber":"40817810000000002905","agreementNumber":"PIL1","clientCreditName":"Кредит наличными","productGroup":"PIL","contractStatus":"A","principal":{"value":47268039,"minorUnits":100,"currency":"RUR"}},' +
  '{"accountNumber":"40817810000000009999","agreementNumber":"CC1","productGroup":"CCD","contractStatus":"A","principal":{"value":0,"minorUnits":100,"currency":"RUR"}}]}'

test('fetchAccounts добавляет кредиты из договоров к счетам', async () => {
  const { plugin } = pluginWith({ credits: { status: 200, body: LOAN_CONTRACTS } })
  const accounts = await plugin.fetchAccounts(CRED)
  expect(accounts.map((a) => [a.id, a.balance])).toEqual([['loan:PIL1', '-472680.39']])
})

test('договоры не ответили — счета собираются без кредитов, сбор не падает', async () => {
  const { plugin } = pluginWith({
    account: { status: 200, body: '{"accounts":[{"number":"40817810000000002905","description":"Текущий счёт","type":"EE","total":{"value":100,"currency":"RUR","minorUnits":100}}]}' },
    credits: { status: 500 },
  })
  const accounts = await plugin.fetchAccounts(CRED)
  expect(accounts.map((a) => a.id)).toEqual(['40817810000000002905'])
})

test('у кредита истории нет — в банк за ней не ходим', async () => {
  const { plugin, posts } = pluginWith({})
  expect(await plugin.fetchOperations(CRED, 'loan:PIL1', 0, 86_400_000)).toEqual([])
  expect(posts).toEqual([])
})
```

- [ ] **Step 6: красный** — FAIL (кредитов нет; история запрошена).

- [ ] **Step 7: плагин** — `collector/src/plugins/alfa/client.ts`:

```ts
// Кредитные договоры клиента: кредиты в список счетов не входят (спека
// 2026-10-05-loan-balance-design.md §6a)
export const CREDITS_PATH = '/api/v1/credit/info'
```

`collector/src/plugins/alfa/index.ts` — импорты `CREDITS_PATH`, `LOAN_ID_PREFIX`, `toLoanAccounts`; `fetchAccounts`:

```ts
    async fetchAccounts(credentials: Credentials): Promise<CollectedAccount[]> {
      const client = clientFor(credentials)
      const accountsRaw = await client.getJson(ACCOUNTS_PATH)
      const cardsRaw = await client.getJson(CARDS_PATH)
      const accounts = toAccounts(arrayAt(accountsRaw, 'accounts', 'счета'), arrayAt(cardsRaw, 'cards', 'карты'))
      return [...accounts, ...(await loans(client))]
    },
```

и функция модуля:

```ts
// Договоры — дополнение к списку счетов: их отказ не должен отнимать у
// человека остальные счета и операции. Кредиты в этот сбор просто не приедут —
// и об этом остаётся след в консоли окна, а не тишина
async function loans(client: BankClient): Promise<CollectedAccount[]> {
  try {
    return toLoanAccounts(arrayAt(await client.getJson(CREDITS_PATH), 'contracts', 'кредитные договоры'))
  } catch (error) {
    console.warn('Альфа: кредитные договоры не получены', error instanceof Error ? error.name : typeof error)
    return []
  }
}
```

`fetchOperations` первой строкой:

```ts
      // у счёта-кредита истории нет: платежи видны на текущем счёте, откуда
      // списываются, а ручка истории спрашивается по номеру счёта
      if (accountId.startsWith(LOAN_ID_PREFIX)) return []
```

В консоль идёт только имя ошибки: текст `BankHttpError` нёс бы путь, а суммы и адреса в логи не пишутся.

- [ ] **Step 8: зелёный** — проверки `collector/` целиком, включая `shell-allowlist.test.ts` (после задачи 3 снова зелёный: `GET /api/v1/credit/info` вызывается плагином).

- [ ] **Step 9: справочник** — `docs/reference/collector.md`: в пункт Альфа-Банка раздела про остаток кредитных счетов (~:323) — кредиты наличными приходят договорами `GET /api/v1/credit/info`, счётом становится действующий договор кроме кредитной карты, идентификатор — номер договора с приставкой, остаток — долг из `principal`, лимита нет, истории нет, отказ ручки — кредиты в этот сбор не приезжают. Все утверждения — со ссылками на строки `plugins/alfa/map.ts`, `plugins/alfa/index.ts`.

- [ ] **Step 10: коммит**

```bash
git add collector/src/plugins/alfa docs/reference/collector.md
git commit -m "Альфа: кредиты наличными из договоров — долг отрицательным остатком"
```

- [ ] **Step 11: дефекты** (по одному, откат):
  - не отсекать `CCD` → FAIL «кредитные карты из договоров не берутся…» и «fetchAccounts добавляет кредиты…»;
  - `id` из `accountNumber` → FAIL «идентификатор кредита не совпадает…»;
  - убрать `try/catch` в `loans` → FAIL «договоры не ответили…»;
  - убрать проверку приставки в `fetchOperations` → FAIL «у кредита истории нет…»;
  - не вызывать `loans` в `fetchAccounts` → FAIL `shell-allowlist.test.ts` («каждая пара списка оболочки вызывается плагином»).

---

### Task 4a: импорт без операций доставляет остаток

Спека §4, «Поправка 2026-10-05». Добавлена после ревью задач 3–4: без неё долг
привязанного кредита Альфы до счёта не доезжает.

**Files:**
- Modify: `backend/app/imports/schemas.py` (`ParsedImportIn`, ~:143-160)
- Modify/Test: `backend/tests/test_import_autoclose.py` (или соседний тест пути коллектора — по образцу)
- Modify: `collector/src/collect/push.ts` (~:26), `collector/src/collect/push.test.ts`, при необходимости `collect-bank.test.ts`
- Modify: `docs/reference/imports.md`, `docs/reference/collector.md` (~:296 «Пустой список не отправляется вовсе»); генерация `uv run python scripts/gen_reference.py` в `backend/`

- [ ] **Step 1: тесты бэкенда** (pytest + testcontainers, по образцу соседних тестов `/api/imports/parsed`):
  - импорт коллектора с `operations: []` и блоком счёта (`balance: "-472680.39"`) → 201, импорт закрыт сам (`completed`, ноль импортированных), остаток счёта стал `-472680.39`;
  - `operations: []` без блока счёта → 422;
  - импорт с операциями — как раньше (существующие тесты).
- [ ] **Step 2: красный.**
- [ ] **Step 3: бэкенд** — в `ParsedImportIn` `operations` с `min_length=0` и проверка модели: пустой список допустим только при непустом блоке `account` (иначе ошибка валидации с понятным текстом без сумм). Автозакрытие из одних дублей (`close_duplicate_only_imports`) закрывает такой импорт само: новых операций ноль. Если путь коллектора где-то ещё полагается на непустой список (подсчёт, превью, лог) — поправить и проверить тестом.
- [ ] **Step 4: тесты коллектора** (`push.test.ts`): пустой список и счёт с остатком → запрос уходит с `operations: []` и блоком счёта; пустой список и остаток `null` → запроса нет, `null`; в `collect-bank.test.ts` — привязанный счёт без операций, но с остатком, получает `importId` и `importClosed` из ответа.
- [ ] **Step 5: коллектор** — в `pushOperations` вместо `if (operations.length === 0) return null`:

```ts
  // без операций импорт нужен только ради остатка: счёт без движения за период
  // (и кредит, у которого истории нет вовсе) иначе не обновил бы его никогда
  if (operations.length === 0 && (account === undefined || account.balance === null)) return null
```

- [ ] **Step 6: справочник** — `imports.md` (импорт коллектора без операций допустим с блоком счёта и закрывается сам), `collector.md:~296` (когда отправляется импорт без операций); генерация справочника бэкенда, если схема ручек изменилась.
- [ ] **Step 7: проверки** — бэкенд целиком (`uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run lint-imports && uv run pytest`; на Windows при сбое установки — `UV_LINK_MODE=copy uv sync`), коллектор целиком.
- [ ] **Step 8: коммит** — «Импорт без операций доставляет остаток счёта и закрывается сам».
- [ ] **Step 9: дефекты**: `min_length=1` обратно → FAIL тест пустого импорта; проверка блока счёта убрана → FAIL «без блока — 422»; в `pushOperations` прежнее условие → FAIL тест коллектора.

---

### Task 5: экран — «долг» у счёта без лимита

**Files:**
- Modify: `frontend/src/components/AccountBalance.tsx` (~:57-60)
- Modify: `frontend/src/components/AccountBalance.test.tsx`

- [ ] **Step 1: тесты** — в `AccountBalance.test.tsx` (объект `debit` уже есть в файле — счёт без лимита):

```ts
test('счёт без лимита с отрицательным остатком — главное число «долг» без знака', () => {
  renderBalance({ ...debit, balance: '-471953.0000' })

  expect(shown()).toContain('долг 471 953,00')
  expect(shown()).not.toContain('-471')
})

test('счёт без лимита с нулевым остатком — сумма, а не долг', () => {
  renderBalance({ ...debit, balance: '0.0000' })

  expect(shown()).not.toMatch(/долг/u)
})
```

Тест «счёт без лимита выглядит как раньше» (положительный остаток) остаётся.

- [ ] **Step 2: красный** — `pnpm test src/components/AccountBalance.test.tsx` → FAIL.

- [ ] **Step 3: реализация** — во второй ветке `AccountBalance` главное число:

```tsx
      <Text fw={700} size={size} ta={ta}>
        {debt !== null ? `долг ${formatMoney(debt, currency)}` : formatMoney(balance, currency)}
      </Text>
```

В докстринге компонента дописать: «У любого счёта отрицательный остаток пишется долгом: кредит, кредитка, карта в минусе. В сумме по счетам знак остаётся».

- [ ] **Step 4: зелёный** — проверки `frontend/`.

- [ ] **Step 5: коммит**

```bash
git add frontend/src/components
git commit -m "Экран счёта: отрицательный остаток пишется долгом"
```

- [ ] **Step 6: дефект** — вернуть `formatMoney(balance, currency)` в главное число → FAIL «счёт без лимита с отрицательным остатком…». Откатить.

---

### Task 6: бэклог и сверка справочника

**Files:**
- Modify: `docs/backlog.md` (пункт «Остаток кредитных счетов» ~:155)

- [ ] **Step 1:** в пункте «Остаток кредитных счетов» заменить «Открытым остаётся… кредиты наличными и «Долями»» и «Что осталось решить» на: кредиты наличными Т-Банка и Альфа-Банка закрыты 2026-10-05 (`2026-10-05-loan-balance-design.md`); открытым остаётся «Долями» — долг на открытых покупках (`approvedLimit − availableLimit`) не проверен, у владельца покупок нет; кредиты Сбербанка не замерялись. Платежи по кредиту — пункт «Анализ кредитов и будущих платежей»: дописать туда, какие поля есть у Т-Банка (`nextPaymentAmount`, `nextPaymentDate`, `remainingPaymentsCount`, `maxRepaymentAmount`, `overdue`) и у Альфы (`nextPayment`, `payment`, `fullPartRepay`) — по §5 и §6a спеки.

- [ ] **Step 2:** скриптом проверить все ссылки `файл:строка` в `docs/reference/collector.md` и `docs/backlog.md` на файлы, тронутые веткой: файл есть, строка в пределах и про названное.

- [ ] **Step 3: коммит**

```bash
git add docs/backlog.md docs/reference
git commit -m "Бэклог: кредиты наличными закрыты, открыты «Долями» и кредиты Сбербанка"
```

---

### Task 7: приёмка

- [ ] **Step 1:** все команды проверки трёх пакетов; `git fetch origin && git log --oneline HEAD..origin/main` — пусто, иначе `git rebase origin/main` и прогнать заново.
- [ ] **Step 2:** ревью ветки субагентом `superpowers:code-reviewer` с мутантами; в брифе — сверка `docs/reference/collector.md` с дифом.
- [ ] **Step 3:** PR в `main`, автослияние после зелёного CI.
- [ ] **Step 4:** после слияния — пересборка приложения из `main` и **живой прогон с разрешения владельца**: сбор Т-Банка и Альфы; завести счета-кредиты из «Есть в банке, но не ведётся»; сверить:
  - число кредита Т-Банка в приложении — с главным числом страницы кредита в кабинете;
  - число кредита Альфы — с «Остатком задолженности»;
  - отдаёт ли Т-Банк операции по `CashLoan` и не задвоились ли они с платежом на текущем счёте (спека §6a, открытый вопрос). Задвоение — отдельной задачей отдавать по кредиту Т-Банка пустую историю, как у Альфы.
