# Опциональная категория (операции + правила) — план реализации

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНАЯ САБ-СКИЛЛ —
> superpowers:subagent-driven-development (рекомендуется) либо
> superpowers:executing-plans. Шаги отмечаются чекбоксами (`- [ ]`).

**Цель:** сделать категорию необязательной при создании/правке операций и правил
регулярки; направление (расход/доход) задаёт пользователь явно (знак суммы),
некатегоризированные расходы видны на дашборде в бакете «Без категории».

**Архитектура:** правка существующих модулей `ledger` и `recurring`. Единая точка
проведения `ledger.service.validate_posting` начинает принимать пустую категорию
(тогда проверяется только знак ≠ 0; при заданной категории — сверка kind как
раньше). `transactions.category_id` уже nullable; `recurring_rules.category_id`
становится nullable миграцией `0004`. Дашборд переходит на LEFT JOIN категории.
Фронт: сегмент-контрол «Расход/Доход» вместо вывода направления из `category.kind`.

**Стек:** FastAPI, SQLAlchemy 2 async, Alembic, Pydantic v2, pytest +
testcontainers; React 19 + TS + Vite, Mantine v9, vitest.

**Ключевые решения (из спеки):**

- Направление кодируется знаком `amount` (без отдельной колонки).
- Категория — опциональный тег везде (операции и правила).
- При заданной категории её `kind` обязан соответствовать знаку (422); в UI
  список категорий фильтруется направлением, поэтому 422 в норме не всплывает.
- Некатегоризированные расходы месяца → бакет `category_id=null`,
  `category_name="Без категории"`.

**Порядок:** Фаза 0 (миграция + модель) → Фаза 1 (backend: валидация,
транзакции, дашборд, правила) → Фаза 2 (frontend: формы).

## Структура файлов

- `backend/app/recurring/models.py` — `category_id` → nullable.
- `backend/alembic/versions/0004_recurring_optional_category.py` — миграция.
- `backend/app/ledger/service.py` — `validate_posting`/`post_transaction`/
  `update_transaction` принимают пустую категорию.
- `backend/app/ledger/schemas.py` — `TransactionCreate.category_id` опционален;
  `MonthExpense.category_id` → `uuid.UUID | None`.
- `backend/app/ledger/repository.py` — `month_expenses_by_category` на LEFT JOIN.
- `backend/app/recurring/schemas.py` — `RuleCreate.category_id`/`RuleOut.category_id`
  опциональны.
- `backend/app/recurring/service.py` — `_validate`/`create_rule` принимают пустую
  категорию.
- `frontend/src/api/ledger.ts`, `frontend/src/api/recurring.ts` — `category_id`
  опционален в телах создания.
- `frontend/src/pages/TransactionForm.tsx`, `RecurringRuleForm.tsx` — сегмент-
  контрол направления + опциональная фильтруемая категория.

---

## Фаза 0. Данные

### Задача 1: `recurring_rules.category_id` → nullable (миграция `0004`)

**Файлы:**
- Modify: `backend/app/recurring/models.py`
- Create: `backend/alembic/versions/0004_recurring_optional_category.py`
- Test: `backend/tests/test_migrations.py`

- [ ] **Шаг 1: Сделать поле модели опциональным**

В `backend/app/recurring/models.py` заменить строку категории правила:

```python
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id"), nullable=True
    )
```

- [ ] **Шаг 2: Миграция**

Создать `backend/alembic/versions/0004_recurring_optional_category.py`:

```python
"""recurring_rules.category_id становится опциональным"""

import sqlalchemy as sa

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("recurring_rules", "category_id", existing_type=sa.Uuid(), nullable=True)


def downgrade() -> None:
    op.alter_column("recurring_rules", "category_id", existing_type=sa.Uuid(), nullable=False)
```

- [ ] **Шаг 3: Тест миграции — колонка стала nullable**

В `backend/tests/test_migrations.py` добавить:

```python
async def test_recurring_category_is_nullable(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name = 'recurring_rules' AND column_name = 'category_id'"
            )
        )
        assert result.scalar() == "YES"
    await engine.dispose()
```

- [ ] **Шаг 4: Проверки**

Run: `cd backend && uv run alembic upgrade head` на чистой БД не нужен вручную —
достаточно `uv run alembic check` (Docker есть): ожидается `No new upgrade
operations detected` (модель ↔ миграции совпадают).
Run: `cd backend && uv run pytest tests/test_migrations.py -q && uv run mypy && uv run ruff check .`
Expected: PASS; mypy/ruff чисто.

- [ ] **Шаг 5: Коммит**

```bash
git add backend/app/recurring/models.py \
        backend/alembic/versions/0004_recurring_optional_category.py \
        backend/tests/test_migrations.py
git commit -m "Recurring: category_id правила становится опциональным (миграция 0004)"
```

---

## Фаза 1. Backend

### Задача 2: Опциональная категория для транзакций

**Файлы:**
- Modify: `backend/app/ledger/schemas.py` (`TransactionCreate.category_id`)
- Modify: `backend/app/ledger/service.py` (`validate_posting`, `post_transaction`, `update_transaction`)
- Test: `backend/tests/test_transactions_api.py`

- [ ] **Шаг 1: Тесты (падают)**

В `backend/tests/test_transactions_api.py` добавить (helper `_setup` в файле уже
есть — возвращает `ws`, `acc1`, `acc2`, `food`, `salary`):

```python
async def test_expense_without_category(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={"account_id": s["acc1"], "amount": "-500.00", "occurred_at": "2026-07-05"},
    )
    assert resp.status_code == 201
    assert resp.json()["category_id"] is None
    assert resp.json()["amount"] == "-500.0000"


async def test_income_without_category(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={"account_id": s["acc1"], "amount": "700.00", "occurred_at": "2026-07-05"},
    )
    assert resp.status_code == 201
    assert resp.json()["category_id"] is None


async def test_zero_amount_still_rejected_without_category(client: AsyncClient) -> None:
    s = await _setup(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={"account_id": s["acc1"], "amount": "0.00", "occurred_at": "2026-07-05"},
    )
    assert resp.status_code == 422
```

(Существующие тесты — знак vs kind при заданной категории 422, patch-инвариант —
должны остаться зелёными без изменений.)

- [ ] **Шаг 2: Убедиться, что падают**

Run: `cd backend && uv run pytest tests/test_transactions_api.py -q`
Expected: FAIL (сейчас `category_id` обязателен — 422 на запрос без него).

- [ ] **Шаг 3: Схема — опциональная категория**

В `backend/app/ledger/schemas.py` в `TransactionCreate` заменить поле:

```python
    category_id: uuid.UUID | None = None
```

(`TransactionUpdate.category_id` уже `uuid.UUID | None = None`;
`TransactionOut.category_id` уже `uuid.UUID | None`.)

- [ ] **Шаг 4: `validate_posting` — категория необязательна**

В `backend/app/ledger/service.py` заменить тело `validate_posting` (сигнатуру
`category_id` сделать `uuid.UUID | None`):

```python
async def validate_posting(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    account_id: uuid.UUID,
    category_id: uuid.UUID | None,
    amount: Decimal,
) -> Account:
    """Проверить счёт (workspace) и, если категория задана, соответствие её kind
    знаку суммы. Категория опциональна; знак ≠ 0 требуется всегда."""
    account = await repository.get_account(db, workspace_id, account_id)
    if account is None:
        raise NotFoundError
    if amount == 0:
        raise SignMismatchError
    if category_id is not None:
        category = await repository.get_category(db, workspace_id, category_id)
        if category is None:
            raise NotFoundError
        if (category.kind == "expense") != (amount < 0):
            raise SignMismatchError
    return account
```

- [ ] **Шаг 5: `post_transaction` — опциональная категория в сигнатуре**

В `backend/app/ledger/service.py` в `post_transaction` поменять тип параметра:

```python
    category_id: uuid.UUID | None,
```

Тело не меняется (`category_id` пробрасывается в `Transaction`; поле модели уже
nullable). `create_transaction` тоже не меняется — он передаёт
`payload.category_id` (теперь может быть `None`).

- [ ] **Шаг 6: `update_transaction` — null-категория валидна**

В `backend/app/ledger/service.py` заменить блок валидации внутри
`update_transaction` (сейчас он требует `new_category_id is not None`):

```python
    new_category_id = (
        payload.category_id if payload.category_id is not None else transaction.category_id
    )
    new_amount = payload.amount if payload.amount is not None else transaction.amount
    if new_amount == 0:
        raise SignMismatchError
    if new_category_id is not None:
        category = await repository.get_category(db, workspace_id, new_category_id)
        if category is None:
            raise NotFoundError
        if (category.kind == "expense") != (new_amount < 0):
            raise SignMismatchError

    transaction.category_id = new_category_id
    if payload.amount is not None:
        transaction.amount = payload.amount
```

(Остальная часть `update_transaction` — occurred_at/merchant/note/commit — без
изменений.)

- [ ] **Шаг 7: Прогон**

Run: `cd backend && uv run pytest tests/test_transactions_api.py -q`
Expected: PASS (операция без категории 201; знак vs kind при заданной категории
по-прежнему 422; amount 0 → 422).

- [ ] **Шаг 8: Линт, типы, весь набор**

Run: `cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run lint-imports && uv run pytest -q`
Expected: зелёное; `4 kept` (при необходимости `uv run ruff format .`).

- [ ] **Шаг 9: Коммит**

```bash
git add backend/app/ledger/schemas.py backend/app/ledger/service.py \
        backend/tests/test_transactions_api.py
git commit -m "Ledger: категория операции опциональна (знак задаёт направление)"
```

---

### Задача 3: Дашборд — бакет «Без категории»

**Файлы:**
- Modify: `backend/app/ledger/schemas.py` (`MonthExpense.category_id`)
- Modify: `backend/app/ledger/repository.py` (`month_expenses_by_category`)
- Modify: `backend/app/ledger/service.py` (`build_dashboard` — имя бакета)
- Test: `backend/tests/test_dashboard_api.py`

- [ ] **Шаг 1: Тест (падает)**

В `backend/tests/test_dashboard_api.py` добавить (helper `_setup` возвращает
`ws`, `acc`, `food`):

```python
async def test_uncategorized_expenses_bucket(client: AsyncClient) -> None:
    s = await _setup(client)
    today = date.today().isoformat()
    # расход без категории
    await client.post(
        "/api/transactions",
        params={"workspace_id": s["ws"]},
        json={"account_id": s["acc"], "amount": "-400.00", "occurred_at": today},
    )
    resp = await client.get("/api/dashboard", params={"workspace_id": s["ws"]})
    bucket = next(m for m in resp.json()["month_expenses"] if m["category_id"] is None)
    assert bucket["category_name"] == "Без категории"
    assert bucket["total"] == "400.0000"
```

- [ ] **Шаг 2: Убедиться, что падает**

Run: `cd backend && uv run pytest tests/test_dashboard_api.py::test_uncategorized_expenses_bucket -q`
Expected: FAIL (INNER JOIN исключает операции без категории — бакета нет).

- [ ] **Шаг 3: Схема — category_id опционален**

В `backend/app/ledger/schemas.py` в `MonthExpense` заменить поле:

```python
    category_id: uuid.UUID | None
```

- [ ] **Шаг 4: Repository — LEFT JOIN и группировка по category_id**

В `backend/app/ledger/repository.py` заменить `month_expenses_by_category`:

```python
async def month_expenses_by_category(
    db: AsyncSession, workspace_id: uuid.UUID, month_start: date, next_month_start: date
) -> list[tuple[uuid.UUID | None, str | None, Decimal]]:
    total = func.sum(-Transaction.amount)
    rows = await db.execute(
        select(Transaction.category_id, Category.name, total)
        .outerjoin(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.amount < 0,
            Transaction.transfer_group_id.is_(None),
            Transaction.occurred_at >= month_start,
            Transaction.occurred_at < next_month_start,
        )
        .group_by(Transaction.category_id, Category.name)
        .order_by(total.desc())
    )
    return [(cid, name, Decimal(t)) for cid, name, t in rows.all()]
```

- [ ] **Шаг 5: Service — имя бакета**

В `backend/app/ledger/service.py` в `build_dashboard` заменить сборку
`month_expenses`:

```python
        month_expenses=[
            MonthExpense(category_id=cid, category_name=name or "Без категории", total=total)
            for cid, name, total in expenses
        ],
```

- [ ] **Шаг 6: Прогон**

Run: `cd backend && uv run pytest tests/test_dashboard_api.py -q`
Expected: PASS (бакет «Без категории» появляется; прочие тесты дашборда —
исключение переводов, границы месяца — зелёные).

- [ ] **Шаг 7: Линт, типы, весь набор**

Run: `cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q`
Expected: зелёное (при необходимости `uv run ruff format .`).

- [ ] **Шаг 8: Коммит**

```bash
git add backend/app/ledger/schemas.py backend/app/ledger/repository.py \
        backend/app/ledger/service.py backend/tests/test_dashboard_api.py
git commit -m "Ledger: некатегоризированные расходы в бакете «Без категории» на дашборде"
```

---

### Задача 4: Опциональная категория для правил регулярки

**Файлы:**
- Modify: `backend/app/recurring/schemas.py` (`RuleCreate.category_id`, `RuleOut.category_id`)
- Modify: `backend/app/recurring/service.py` (`_validate` тип, — логика уже совместима)
- Test: `backend/tests/test_recurring_rules_api.py`, `backend/tests/test_recurring_beat.py`

- [ ] **Шаг 1: Тесты (падают)**

В `backend/tests/test_recurring_rules_api.py` добавить (helper `_setup`
возвращает `ws`, `acc`, `rent`; `_rule(s, **over)` строит тело):

```python
async def test_rule_without_category(client: AsyncClient) -> None:
    s = await _setup(client)
    body = _rule(s)
    del body["category_id"]
    resp = await client.post("/api/recurring", params={"workspace_id": s["ws"]}, json=body)
    assert resp.status_code == 201
    assert resp.json()["category_id"] is None
```

В `backend/tests/test_recurring_beat.py` добавить (helper `_setup_rule` строит
правило; тут задаём тело напрямую через API, как в существующих тестах):

```python
async def test_autopost_without_category(client: AsyncClient, db_session: AsyncSession) -> None:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (await client.post("/api/accounts", params={"workspace_id": ws},
           json={"name": "Карта", "type": "card", "currency": "RUB"})).json()
    await client.post("/api/recurring", params={"workspace_id": ws}, json={
        "account_id": acc["id"], "amount": "-30000.00", "period": "month",
        "interval": 1, "anchor_day": 5, "start_date": "2026-01-05", "mode": "autopost"})
    await service.process_due_rules(db_session, TODAY)
    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 1
    assert txns["items"][0]["category_id"] is None
```

- [ ] **Шаг 2: Убедиться, что падают**

Run: `cd backend && uv run pytest tests/test_recurring_rules_api.py::test_rule_without_category tests/test_recurring_beat.py::test_autopost_without_category -q`
Expected: FAIL (сейчас `category_id` обязателен в `RuleCreate` — 422).

- [ ] **Шаг 3: Схемы — опциональная категория**

В `backend/app/recurring/schemas.py`:
- в `RuleCreate` заменить поле на `category_id: uuid.UUID | None = None`;
- в `RuleOut` заменить поле на `category_id: uuid.UUID | None`.

- [ ] **Шаг 4: Service — тип `_validate`**

В `backend/app/recurring/service.py` в `_validate` поменять тип параметра
`category_id` на `uuid.UUID | None` (тело не меняется — оно зовёт
`ledger_service.validate_posting`, которая уже принимает пустую категорию;
`create_rule` передаёт `payload.category_id`, теперь возможно `None`).

```python
async def _validate(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    category_id: uuid.UUID | None,
    amount: Decimal,
) -> object:
```

Автопроведение (`process_due_rules`) и подтверждение (`confirm_occurrence`)
изменений не требуют — они уже передают `rule.category_id` в
`ledger_service.post_transaction`, а тот принимает `None`.

- [ ] **Шаг 5: Прогон**

Run: `cd backend && uv run pytest tests/test_recurring_rules_api.py tests/test_recurring_beat.py tests/test_recurring_occurrences_api.py -q`
Expected: PASS (правило без категории 201; автопост создаёт некатегоризированную
транзакцию; существующие тесты зелёные).

- [ ] **Шаг 6: Линт, типы, import-linter, весь набор**

Run: `cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run lint-imports && uv run pytest -q`
Expected: зелёное; `4 kept` (при необходимости `uv run ruff format .`).

- [ ] **Шаг 7: Коммит**

```bash
git add backend/app/recurring/schemas.py backend/app/recurring/service.py \
        backend/tests/test_recurring_rules_api.py backend/tests/test_recurring_beat.py
git commit -m "Recurring: категория правила опциональна (autopost без категории)"
```

---

## Фаза 2. Frontend

### Задача 5: Форма операции — направление и опциональная категория

**Файлы:**
- Modify: `frontend/src/api/ledger.ts` (`createTransaction` body)
- Modify: `frontend/src/pages/TransactionForm.tsx`
- Test: `frontend/src/pages/TransactionForm.test.tsx`

- [ ] **Шаг 1: api — опциональная категория в теле создания**

В `frontend/src/api/ledger.ts` в `createTransaction` сделать `category_id`
опциональным в типе тела:

```typescript
export const createTransaction = (
  ws: string,
  body: { account_id: string; category_id?: string; amount: string; occurred_at: string; merchant?: string; note?: string },
) => api<Transaction>(`/api/transactions?${q(ws)}`, { method: 'POST', body: JSON.stringify(body) })
```

- [ ] **Шаг 2: Обновить тест формы (сначала — под новое поведение)**

Заменить содержимое `frontend/src/pages/TransactionForm.test.tsx`:

```typescript
import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { Account, Category } from '../api/ledger'
import { TransactionForm } from './TransactionForm'

const accounts: Account[] = [
  { id: 'a1', name: 'Карта', type: 'card', currency: 'RUB', is_archived: false, balance: '0.0000' },
]
const categories: Category[] = [{ id: 'c1', parent_id: null, name: 'Еда', kind: 'expense' }]

function renderForm(onSubmit: (v: unknown) => void) {
  return render(
    <MantineProvider>
      <TransactionForm accounts={accounts} categories={categories} onSubmit={onSubmit} pending={false} />
    </MantineProvider>,
  )
}

test('валидация: без счёта не отправляется', async () => {
  const onSubmit = vi.fn()
  renderForm(onSubmit)
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).not.toHaveBeenCalled()
  expect(await screen.findByText('Выберите счёт')).toBeDefined()
})

test('расход без категории уходит с отрицательным знаком', async () => {
  const onSubmit = vi.fn()
  renderForm(onSubmit)
  await userEvent.click(screen.getByRole('combobox', { name: 'Счёт' }))
  await userEvent.click(await screen.findByText('Карта'))
  await userEvent.type(screen.getByLabelText('Сумма'), '500')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ amount: '-500.00', category_id: undefined }),
  )
})

test('доход уходит с положительным знаком', async () => {
  const onSubmit = vi.fn()
  renderForm(onSubmit)
  await userEvent.click(screen.getByText('Доход'))
  await userEvent.click(screen.getByRole('combobox', { name: 'Счёт' }))
  await userEvent.click(await screen.findByText('Карта'))
  await userEvent.type(screen.getByLabelText('Сумма'), '700')
  await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ amount: '700.00' }))
})
```

- [ ] **Шаг 3: Переписать форму**

Заменить содержимое `frontend/src/pages/TransactionForm.tsx`:

```typescript
import { Button, NumberInput, SegmentedControl, Select, Stack, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import type { Account, Category } from '../api/ledger'

export interface TransactionFormValues {
  account_id: string
  category_id?: string
  amount: string
  occurred_at: string
  merchant?: string
  note?: string
}

export function TransactionForm({
  accounts,
  categories,
  onSubmit,
  pending,
}: {
  accounts: Account[]
  categories: Category[]
  onSubmit: (values: TransactionFormValues) => void
  pending: boolean
}) {
  const form = useForm({
    initialValues: {
      direction: 'expense' as 'expense' | 'income',
      account_id: '',
      category_id: '',
      amount: '',
      occurred_at: new Date().toISOString().slice(0, 10),
      merchant: '',
      note: '',
    },
    validate: {
      account_id: (v) => (v ? null : 'Выберите счёт'),
      amount: (v) => (Number(v) !== 0 && v !== '' ? null : 'Введите сумму'),
    },
  })

  // направление задаёт знак суммы (расход отрицательный); категория опциональна
  const submit = (v: typeof form.values) => {
    const magnitude = Math.abs(Number(v.amount)).toFixed(2)
    const signed = v.direction === 'expense' ? `-${magnitude}` : magnitude
    onSubmit({
      account_id: v.account_id,
      amount: signed,
      occurred_at: v.occurred_at,
      category_id: v.category_id || undefined,
      merchant: v.merchant || undefined,
      note: v.note || undefined,
    })
  }

  // в списке категорий — только соответствующие направлению
  const visibleCategories = categories.filter((c) => c.kind === form.values.direction)

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack>
        <SegmentedControl
          fullWidth
          data={[
            { value: 'expense', label: 'Расход' },
            { value: 'income', label: 'Доход' },
          ]}
          value={form.values.direction}
          onChange={(value) => {
            form.setFieldValue('direction', value as 'expense' | 'income')
            form.setFieldValue('category_id', '')
          }}
        />
        <Select
          label="Счёт"
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          {...form.getInputProps('account_id')}
        />
        <Select
          label="Категория (необязательно)"
          clearable
          data={visibleCategories.map((c) => ({ value: c.id, label: c.name }))}
          {...form.getInputProps('category_id')}
        />
        <NumberInput label="Сумма" {...form.getInputProps('amount')} />
        <TextInput label="Дата" type="date" {...form.getInputProps('occurred_at')} />
        <TextInput label="Продавец" {...form.getInputProps('merchant')} />
        <TextInput label="Заметка" {...form.getInputProps('note')} />
        <Button type="submit" loading={pending}>Сохранить</Button>
      </Stack>
    </form>
  )
}
```

- [ ] **Шаг 4: Прогон**

Run: `cd frontend && pnpm test TransactionForm && pnpm lint`
Expected: PASS (расход без категории → −500.00; доход → 700.00; без счёта не
отправляется).

- [ ] **Шаг 5: Сборка (страница использует форму)**

Run: `cd frontend && pnpm test && pnpm build`
Expected: зелёное (`TransactionsPage` передаёт `TransactionFormValues` в
`createTransaction` — типы сходятся, `category_id` опционален по всей цепочке).

- [ ] **Шаг 6: Коммит**

```bash
git add frontend/src/api/ledger.ts frontend/src/pages/TransactionForm.tsx \
        frontend/src/pages/TransactionForm.test.tsx
git commit -m "Фронт: форма операции — направление Расход/Доход, категория опциональна"
```

---

### Задача 6: Форма правила регулярки — направление и опциональная категория

**Файлы:**
- Modify: `frontend/src/api/recurring.ts` (`RuleInput.category_id`)
- Modify: `frontend/src/pages/RecurringRuleForm.tsx`

- [ ] **Шаг 1: api — категория правила опциональна**

В `frontend/src/api/recurring.ts` в интерфейсе `RuleInput` заменить поле:

```typescript
  category_id: string | null
```

(остальные поля `RuleInput` и `createRule` не меняются — тело уже типизировано
`RuleInput`.)

- [ ] **Шаг 2: Переписать форму правила**

Заменить содержимое `frontend/src/pages/RecurringRuleForm.tsx`:

```typescript
import { Button, NumberInput, SegmentedControl, Select, Stack, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import type { Account, Category } from '../api/ledger'
import type { Mode, Period, RuleInput } from '../api/recurring'

const PERIODS = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'year', label: 'Год' },
]
const MODES = [
  { value: 'autopost', label: 'Проводить автоматически' },
  { value: 'remind', label: 'Напоминать (подтверждаю вручную)' },
]

export function RecurringRuleForm({
  accounts,
  categories,
  onSubmit,
  pending,
}: {
  accounts: Account[]
  categories: Category[]
  onSubmit: (body: RuleInput) => void
  pending: boolean
}) {
  const form = useForm({
    initialValues: {
      direction: 'expense' as 'expense' | 'income',
      account_id: '',
      category_id: '',
      amount: '',
      period: 'month' as Period,
      interval: 1,
      anchor_day: 1,
      start_date: new Date().toISOString().slice(0, 10),
      mode: 'autopost' as Mode,
      end_date: '',
      note: '',
    },
    validate: {
      account_id: (v) => (v ? null : 'Выберите счёт'),
      amount: (v) => (Number(v) !== 0 && v !== '' ? null : 'Введите сумму'),
    },
  })

  // направление задаёт знак суммы; категория опциональна
  const submit = (v: typeof form.values) => {
    const magnitude = Math.abs(Number(v.amount)).toFixed(2)
    const signed = v.direction === 'expense' ? `-${magnitude}` : magnitude
    onSubmit({
      account_id: v.account_id,
      category_id: v.category_id || null,
      amount: signed,
      period: v.period,
      interval: v.interval,
      anchor_day: v.period === 'month' ? v.anchor_day : null,
      start_date: v.start_date,
      mode: v.mode,
      end_date: v.end_date || null,
      note: v.note || null,
    })
  }

  const visibleCategories = categories.filter((c) => c.kind === form.values.direction)

  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack>
        <SegmentedControl
          fullWidth
          data={[
            { value: 'expense', label: 'Расход' },
            { value: 'income', label: 'Доход' },
          ]}
          value={form.values.direction}
          onChange={(value) => {
            form.setFieldValue('direction', value as 'expense' | 'income')
            form.setFieldValue('category_id', '')
          }}
        />
        <Select label="Счёт" data={accounts.map((a) => ({ value: a.id, label: a.name }))} {...form.getInputProps('account_id')} />
        <Select
          label="Категория (необязательно)"
          clearable
          data={visibleCategories.map((c) => ({ value: c.id, label: c.name }))}
          {...form.getInputProps('category_id')}
        />
        <NumberInput label="Сумма" {...form.getInputProps('amount')} />
        <Select label="Период" data={PERIODS} {...form.getInputProps('period')} />
        <NumberInput label="Каждые N периодов" min={1} {...form.getInputProps('interval')} />
        {form.values.period === 'month' && (
          <NumberInput label="День месяца" min={1} max={31} {...form.getInputProps('anchor_day')} />
        )}
        <TextInput label="Дата старта" type="date" {...form.getInputProps('start_date')} />
        <Select label="Режим" data={MODES} {...form.getInputProps('mode')} />
        <TextInput label="Дата окончания (необязательно)" type="date" {...form.getInputProps('end_date')} />
        <TextInput label="Заметка" {...form.getInputProps('note')} />
        <Button type="submit" loading={pending}>Сохранить</Button>
      </Stack>
    </form>
  )
}
```

- [ ] **Шаг 3: Прогон**

Run: `cd frontend && pnpm lint && pnpm test && pnpm build`
Expected: зелёное (форма правила компилируется; `RecurringPage` передаёт
`RuleInput` в `createRule` — `category_id` теперь `string | null`).

- [ ] **Шаг 4: Коммит**

```bash
git add frontend/src/api/recurring.ts frontend/src/pages/RecurringRuleForm.tsx
git commit -m "Фронт: форма правила — направление Расход/Доход, категория опциональна"
```

---

## Самопроверка плана (сверка со спекой)

- Миграция `0004` (recurring_rules.category_id nullable) — задача 1. ✓
- `validate_posting` принимает пустую категорию; знак ≠ 0 всегда; при заданной
  категории — сверка kind (§4) — задача 2. ✓
- `TransactionCreate.category_id`/`update_transaction` — опциональны — задача 2. ✓
- Дашборд «Без категории» (LEFT JOIN, `MonthExpense.category_id` nullable) (§5) —
  задача 3. ✓
- `RuleCreate`/`RuleOut` категория опциональна; autopost/confirm без категории
  создают некатегоризированную транзакцию (§2,§4) — задача 4. ✓
- Frontend: сегмент-контрол Расход/Доход, категория опциональна и фильтруется
  направлением (§6) — задачи 5, 6. ✓
- Тесты: операция/правило без категории, бакет дашборда, страховка знака,
  автопост без категории, форма (знак по направлению) (§7) — по задачам. ✓

Согласованность: `validate_posting(category_id: uuid.UUID | None)`,
`post_transaction`, `_validate`, `month_expenses_by_category` (возврат
`uuid.UUID | None, str | None, Decimal`), `MonthExpense.category_id`,
`TransactionFormValues.category_id?`, `RuleInput.category_id: string | null` —
имена и типы согласованы между задачами. `workspace_id` — query везде.

Вне охвата (по спеке §2): очистка уже проставленной категории через PATCH;
изменение семантики `category.kind`/дерева; AI-категоризация.

---

## Передача в исполнение

План сохранён в `docs/superpowers/plans/2026-07-09-optional-category.md`.

Два режима:
1. **Subagent-Driven (рекомендуется)** — свежий сабагент на задачу, ревью между
   задачами. Саб-скилл: superpowers:subagent-driven-development.
2. **Inline** — пакетами с чекпойнтами. Саб-скилл: superpowers:executing-plans.