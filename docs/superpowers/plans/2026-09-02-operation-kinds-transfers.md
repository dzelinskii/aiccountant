# Виды операций: переводы отдельно от трат — план реализации

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ — использовать
> superpowers:subagent-driven-development (рекомендуется) или
> superpowers:executing-plans. Шаги помечены чекбоксами для отслеживания.

**Цель:** отличать движение денег от трат, чтобы статистика расходов перестала
врать, а категоризация не расходовала вызовы LLM на переводы.

**Архитектура:** коннектор переводит словарь своего банка в наш банконезависимый
словарь видов операций; бэкенд слов конкретного банка не знает. Транзакция
хранит факт от источника (`operation_kind`) и решение человека
(`spending_override`) раздельно. Правило «участвует ли операция в статистике»
живёт одним выражением SQLAlchemy, которым пользуются все запросы.

**Стек:** FastAPI, SQLAlchemy 2 async, Alembic, Pydantic v2, pytest +
testcontainers; коллектор — Node + TypeScript, vitest; фронтенд — React 19,
Mantine, vitest.

**Спека:** `docs/superpowers/specs/2026-09-02-operation-kinds-transfers-design.md`

**Ветка:** работать в `operation-kinds`, создать от свежего `main`.

---

## Карта файлов

**Бэкенд:**

- `app/core/operation_kinds.py` — **создать.** Словарь видов и список видов, не
  участвующих в статистике. Лежит в `core`, а не в `ledger`, потому что нужен и
  `imports.schemas` тоже: `core` — общее место для таких вещей (по образцу
  `app/core/money.py`), и это не нарушает контрактов import-linter.
- `app/ledger/models.py` — два поля у `Transaction`.
- `alembic/versions/0009_operation_kind.py` — **создать.**
- `app/ledger/repository.py` — выражение `counts_in_stats()` и его применение.
- `app/ledger/service.py` — приём вида операции в `post_transaction`,
  переопределение в `update_transaction`, вид у ручных операций и переводов.
- `app/ledger/schemas.py` — вид и переопределение в `TransactionOut` и
  `TransactionUpdate`.
- `app/imports/parser.py` — поле `kind` у `ParsedOperation`.
- `app/imports/schemas.py` — поле `kind` у `ParsedOperationIn`.
- `app/imports/service.py` — вид попадает в payload, читается обратно и уходит в
  транзакцию; применение правил при подтверждении.
- `alembic/versions/0010_description_rules.py` — **создать.**
- `app/ledger/router.py` — управление правилами.

**Коллектор:**

- `collector/src/plugins/tbank/types.ts` — поле `kind`.
- `collector/src/plugins/tbank/map.ts` — отображение `group` банка в наш вид.
- `collector/src/runner/main.ts` — счётчик операций с неизвестным видом.

**Фронтенд:**

- `frontend/src/api/ledger.ts` — поля в типе операции.
- `frontend/src/pages/TransactionsPage.tsx` — пометка и переключатель.

---

## Task 1: Словарь видов операций и поля транзакции

**Files:**
- Create: `backend/app/core/operation_kinds.py`
- Modify: `backend/app/ledger/models.py`
- Create: `backend/alembic/versions/0009_operation_kind.py`
- Test: `backend/tests/test_operation_kinds.py`

- [ ] **Шаг 1: Создать словарь**

`backend/app/core/operation_kinds.py`:

```python
from typing import Literal

# Банконезависимый словарь видов операций. Коннектор каждого банка переводит
# словарь своего банка в этот; бэкенд слов конкретного банка не знает.
OperationKind = Literal[
    "purchase",  # оплата товаров и услуг
    "transfer_person",  # перевод человеку
    "transfer_self",  # между своими счетами
    "cash",  # операции с наличными
    "loan",  # платежи по кредиту
    "income",  # поступление
    "unknown",  # источник не сообщил вид
]

OPERATION_KINDS: tuple[str, ...] = (
    "purchase",
    "transfer_person",
    "transfer_self",
    "cash",
    "loan",
    "income",
    "unknown",
)

# Не экономические события: деньги лишь меняют место или форму. Из статистики
# и категоризации исключаются. unknown сюда намеренно не входит — неизвестная
# операция должна остаться видимой, а не пропасть молча.
NON_SPENDING_KINDS: tuple[str, ...] = ("transfer_self", "cash")
```

- [ ] **Шаг 2: Падающий тест на поля модели**

Создать `backend/tests/test_operation_kinds.py`:

```python
import uuid
from decimal import Decimal

from httpx import AsyncClient

from app.core.operation_kinds import NON_SPENDING_KINDS, OPERATION_KINDS

ALICE = {"email": "alice@example.com", "password": "password123"}


def test_non_spending_kinds_are_known() -> None:
    """Список исключаемых видов не должен разъезжаться со словарём."""
    assert set(NON_SPENDING_KINDS) <= set(OPERATION_KINDS)


def test_unknown_is_not_excluded() -> None:
    """unknown остаётся тратой: ничего не исчезает молча."""
    assert "unknown" not in NON_SPENDING_KINDS


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def test_manual_transaction_defaults_to_purchase(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": acc, "amount": "-100.00", "occurred_at": "2026-09-01"},
    )
    assert resp.status_code == 201
    assert resp.json()["operation_kind"] == "purchase"
    assert resp.json()["spending_override"] is None
```

- [ ] **Шаг 3: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_operation_kinds.py -q`
Ожидание: FAIL — в ответе нет ключа `operation_kind`.

- [ ] **Шаг 4: Добавить поля в модель**

В `backend/app/ledger/models.py` в класс `Transaction`, сразу после
`transfer_group_id`:

```python
    # вид операции в нашем словаре (app/core/operation_kinds.py) — факт от
    # источника, не меняется человеком
    operation_kind: Mapped[str] = mapped_column(
        String(20), default="unknown", server_default=text("'unknown'")
    )
    # решение человека «считать тратой»; null — решает правило по виду операции.
    # Держим отдельно от вида, чтобы смена правил не затирала ручные правки
    spending_override: Mapped[bool | None] = mapped_column(nullable=True)
```

- [ ] **Шаг 5: Миграция**

Создать `backend/alembic/versions/0009_operation_kind.py`:

```python
"""Вид операции и переопределение «считать тратой»"""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # существующие строки получают unknown: остаются тратами, поведение
    # задним числом не меняется
    op.add_column(
        "transactions",
        sa.Column(
            "operation_kind",
            sa.String(20),
            nullable=False,
            server_default=sa.text("'unknown'"),
        ),
    )
    op.add_column(
        "transactions", sa.Column("spending_override", sa.Boolean(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("transactions", "spending_override")
    op.drop_column("transactions", "operation_kind")
```

- [ ] **Шаг 6: Отдать поля наружу и проставлять вид у ручных операций**

В `backend/app/ledger/schemas.py` в `TransactionOut` после
`transfer_group_id`:

```python
    operation_kind: str
    spending_override: bool | None
```

В `backend/app/ledger/service.py` в `post_transaction` добавить параметр после
`import_id`:

```python
    operation_kind: str = "unknown",
```

и передать его в конструктор `Transaction(...)`:

```python
        operation_kind=operation_kind,
```

В том же файле в `create_transaction` (ручной ввод из UI) передать вид по знаку
суммы — там, где вызывается `post_transaction`:

```python
        operation_kind="purchase" if payload.amount < 0 else "income",
```

В `create_transfer` обеим строкам перевода добавить в конструктор
`Transaction(...)`:

```python
        operation_kind="transfer_self",
```

- [ ] **Шаг 7: Прогнать — проходит**

Run: `cd backend && uv run pytest tests/test_operation_kinds.py -q`
Ожидание: PASS, 3 теста.

- [ ] **Шаг 8: Коммит**

```bash
git add backend/app/core/operation_kinds.py backend/app/ledger/models.py \
  backend/app/ledger/schemas.py backend/app/ledger/service.py \
  backend/alembic/versions/0009_operation_kind.py backend/tests/test_operation_kinds.py
git commit -m "Учёт: вид операции и переопределение «считать тратой»"
```

---

## Task 2: Правило «участвует в статистике» и его применение

**Files:**
- Modify: `backend/app/ledger/repository.py`
- Test: `backend/tests/test_operation_kinds.py` (дополнить)

**Зачем.** Сейчас запросы статистики и категоризации отсекают переводы условием
`Transaction.transfer_group_id.is_(None)` — оно ловит только парные переводы,
созданные вручную. Односторонние движения денег из импорта им не ловятся. Плюс
условие продублировано в двух местах и разъедется при первой же правке.

**Зависимость:** тесты этой задачи станут зелёными только вместе с Task 3,
который добавляет приём поля `kind`. Это учтено в шагах.

- [ ] **Шаг 1: Падающие тесты**

Дополнить `backend/tests/test_operation_kinds.py`:

```python
async def _post_kind(client: AsyncClient, ws: str, acc: str, kind: str, amount: str) -> None:
    """Создать и подтвердить операцию нужного вида через эндпоинт импорта:
    ручной ввод вид задать не позволяет, а лезть в БД мимо API значит проверять
    не то, чем пользуется приложение."""
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "test_collector",
            "operations": [
                {
                    "occurred_at": "2026-09-01",
                    "amount": amount,
                    "currency": "RUB",
                    "description": f"операция {kind}",
                    "external_id": f"op-{kind}-{amount}",
                    "kind": kind,
                }
            ],
        },
    )
    import_id = resp.json()["import_id"]
    await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})


async def _month_expenses_total(client: AsyncClient, ws: str) -> Decimal:
    # ключ именно total (см. MonthExpense в app/ledger/schemas.py), не amount
    dashboard = await client.get("/api/dashboard", params={"workspace_id": ws})
    return sum(
        (Decimal(row["total"]) for row in dashboard.json()["month_expenses"]),
        Decimal(0),
    )


async def test_transfer_self_is_out_of_month_expenses(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "purchase", "-100.00")
    await _post_kind(client, ws, acc, "transfer_self", "-5000.00")
    assert await _month_expenses_total(client, ws) == Decimal("100.00")


async def test_cash_is_out_of_month_expenses(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "purchase", "-100.00")
    await _post_kind(client, ws, acc, "cash", "-3000.00")
    assert await _month_expenses_total(client, ws) == Decimal("100.00")


async def test_unknown_kind_stays_in_expenses(client: AsyncClient) -> None:
    """Неизвестный вид не прячем: деньги должны оставаться видимыми."""
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "unknown", "-700.00")
    assert await _month_expenses_total(client, ws) == Decimal("700.00")


async def test_loan_and_person_transfer_are_expenses(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "loan", "-1000.00")
    await _post_kind(client, ws, acc, "transfer_person", "-2000.00")
    assert await _month_expenses_total(client, ws) == Decimal("3000.00")


async def test_transfer_self_is_not_categorized(client: AsyncClient) -> None:
    """Категоризации нечего делать с перекладыванием денег между своими счетами."""
    from app.ledger import repository

    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "transfer_self", "-5000.00")
    await _post_kind(client, ws, acc, "purchase", "-100.00")

    from app.core.db import session_factory

    async with session_factory() as db:
        pending = await repository.list_uncategorized(db, uuid.UUID(ws))
    assert [t.operation_kind for t in pending] == ["purchase"]
```

Имена в коде проверены и верны: ручка `GET /api/dashboard`
(`app/ledger/router.py:239`), ключ `month_expenses` с полем `total` внутри
(`DashboardOut` и `MonthExpense` в `app/ledger/schemas.py`), фабрика сессий
`session_factory` в `app/core/db.py:24`. Образец теста, ходящего в БД напрямую, —
`test_corrupted_external_ids_raises` в `tests/test_imports_parsed.py`.

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_operation_kinds.py -q`
Ожидание: FAIL — 422 на неизвестное поле `kind` (его добавит Task 3).

- [ ] **Шаг 3: Выражение правила**

В `backend/app/ledger/repository.py` добавить импорты (часть может уже быть —
проверить и не дублировать):

```python
from sqlalchemy import and_, func
from sqlalchemy.sql.elements import ColumnElement

from app.core.operation_kinds import NON_SPENDING_KINDS
```

И само выражение рядом с остальными функциями модуля:

```python
def counts_in_stats() -> ColumnElement[bool]:
    """Участвует ли операция в статистике и категоризации.

    Перекладывание денег между своими счетами и операции с наличными
    экономическим событием не являются. Решение человека перекрывает правило
    в обе стороны.

    Правило намеренно живёт одним выражением: до этого оно было продублировано
    в двух запросах, и любая правка разводила дашборд с категоризацией.
    """
    by_kind = and_(
        Transaction.transfer_group_id.is_(None),
        Transaction.operation_kind.notin_(NON_SPENDING_KINDS),
    )
    return func.coalesce(Transaction.spending_override, by_kind)
```

- [ ] **Шаг 4: Применить в обоих запросах**

В `backend/app/ledger/repository.py` в `month_expenses_by_category` заменить

```python
            Transaction.transfer_group_id.is_(None),
```

на

```python
            counts_in_stats(),
```

То же самое в `list_uncategorized`.

- [ ] **Шаг 5: Прогнать полностью**

Run: `cd backend && uv run pytest -q`
Ожидание: тесты Task 2 всё ещё красные (ждут Task 3), **все остальные зелёные** —
регрессий нет.

- [ ] **Шаг 6: Коммит**

```bash
git add backend/app/ledger/repository.py backend/tests/test_operation_kinds.py
git commit -m "Учёт: одно правило участия операции в статистике"
```

- [ ] **Шаг 7: Мутационная проверка (после того как Task 3 сделает тесты зелёными)**

Вернуться сюда, когда Task 3 закрыт, и убедиться, что тесты действительно
кусаются:

1. заменить в `counts_in_stats()` `Transaction.operation_kind.notin_(NON_SPENDING_KINDS)`
   на `sa.true()` — должны покраснеть тесты про `transfer_self` и `cash`;
2. заменить `func.coalesce(Transaction.spending_override, by_kind)` на `by_kind` —
   должен покраснеть тест переопределения из Task 5;
3. вернуть как было и убедиться, что всё снова зелёное.

Если какая-то мутация не ловится — тест ничего не гарантирует, переписать его,
а не подгонять мутацию.

Два теста этой задачи — `test_unknown_stays_in_month_expenses` и
`test_loan_and_transfer_person_stay_in_month_expenses` — до Task 3 зелёные
вхолостую: они утверждают «операция осталась в расходах», а под умолчанием
`unknown` это выполняется само собой. Различающую силу они получат, когда вид
начнёт доезжать до строки. Проверить это отдельно: временно вернуть в
`counts_in_stats()` исключение по `unknown` — тест про `unknown` обязан
покраснеть.

Отдельная дыра, найденная при работе над этой задачей и существовавшая до неё:
`test_list_uncategorized_excludes_categorized_suggested_and_transfers`
(`tests/test_categorize_repository.py:50`) **вопреки имени перевода не создаёт
вовсе** — только операции без категории, с категорией и с подсказкой. То есть
исключение переводов из категоризации этим тестом не покрыто. Имя исправить или
дописать в него собственно перевод.

---

## Task 3: Вид операции в договоре API импорта

**Files:**
- Modify: `backend/app/imports/schemas.py`
- Modify: `backend/app/imports/parser.py`
- Modify: `backend/app/imports/service.py`
- Test: `backend/tests/test_imports_parsed.py` (дополнить)

- [ ] **Шаг 1: Падающие тесты**

Дополнить `backend/tests/test_imports_parsed.py`:

```python
async def test_kind_is_stored_on_transaction(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPS[0], "kind": "transfer_self"}],
        },
    )
    await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    listed = await client.get("/api/transactions", params={"workspace_id": ws})
    assert listed.json()["items"][0]["operation_kind"] == "transfer_self"


async def test_kind_defaults_to_unknown(client: AsyncClient) -> None:
    """Запрос без kind остаётся валидным: выписка из PDF вида не даёт."""
    ws, acc = await _ws_and_account(client)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": [OPS[0]]},
    )
    await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    listed = await client.get("/api/transactions", params={"workspace_id": ws})
    assert listed.json()["items"][0]["operation_kind"] == "unknown"


async def test_bank_vocabulary_is_rejected(client: AsyncClient) -> None:
    """PAY — слово Т-Банка, а не наше. Переводить словарь обязан коннектор,
    и граница API это проверяет, а не принимает на веру."""
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": [{**OPS[0], "kind": "PAY"}]},
    )
    assert resp.status_code == 422
```

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_imports_parsed.py -q`
Ожидание: FAIL — в ответе нет `operation_kind`, а `kind: "PAY"` проходит.

- [ ] **Шаг 3: Поле во входной схеме**

В `backend/app/imports/schemas.py` добавить импорт:

```python
from app.core.operation_kinds import OperationKind
```

и поле в `ParsedOperationIn` после `external_id`:

```python
    # вид операции в нашем словаре; словарь конкретного банка переводит коннектор.
    # unknown по умолчанию — источники без классификации (PDF-выписка) валидны
    kind: OperationKind = "unknown"
```

- [ ] **Шаг 4: Вид переживает сохранение в payload**

В `backend/app/imports/parser.py` дополнить `ParsedOperation`:

```python
@dataclass
class ParsedOperation:
    occurred_at: date
    amount: Decimal  # знаковая: расход < 0, доход > 0
    currency: str
    description: str
    # значение по умолчанию — чтобы парсеры PDF и LLM не менялись: они вида не знают
    kind: str = "unknown"
```

В `backend/app/imports/service.py` в `_statement_to_payload` добавить ключ в
словарь операции:

```python
                "kind": op.kind,
```

Там же, где payload читается обратно в `ParsedOperation`, добавить:

```python
                kind=str(op.get("kind", "unknown")),
```

В `create_parsed_import` при построении `ParsedOperation` из `ParsedOperationIn`:

```python
                kind=op.kind,
```

- [ ] **Шаг 5: Вид доезжает до транзакции**

В `backend/app/imports/service.py` в подтверждении импорта, в вызове
`ledger_service.post_transaction`, добавить аргумент:

```python
            operation_kind=op.kind,
```

- [ ] **Шаг 6: Прогнать**

Run: `cd backend && uv run pytest tests/test_imports_parsed.py tests/test_operation_kinds.py -q`
Ожидание: PASS — зелёными становятся и тесты Task 2.

- [ ] **Шаг 7: Гейты**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`
Ожидание: всё зелёное, 7 контрактов import-linter целы.

- [ ] **Шаг 8: Коммит**

```bash
git add backend/app/imports/ backend/tests/test_imports_parsed.py
git commit -m "Импорт: вид операции в договоре API и до самой транзакции"
```

---

## Task 4: Коллектор переводит словарь Т-Банка в наш

**Files:**
- Modify: `collector/src/plugins/tbank/types.ts`
- Modify: `collector/src/plugins/tbank/map.ts`
- Modify: `collector/src/runner/main.ts`
- Modify: `collector/src/runner/push.ts` (проверить, что `kind` уходит в теле)
- Test: `collector/src/plugins/tbank/map.test.ts` (дополнить)
- Test: `collector/tests/fixtures/operations.json` (дополнить)

**Зачем.** Это единственное место во всей системе, где живут слова Т-Банка.
Появится второй банк — появится второй плагин, ядро не изменится.

- [ ] **Шаг 1: Падающие тесты**

Дополнить `collector/src/plugins/tbank/map.test.ts`:

```typescript
test('группы банка переводятся в наш словарь', () => {
  const cases: [string, string][] = [
    ['PAY', 'purchase'],
    ['TRANSFER', 'transfer_person'],
    ['INTERNAL', 'transfer_self'],
    ['CASH', 'cash'],
    ['LOANREPAY', 'loan'],
    ['INCOME', 'income'],
  ]
  for (const [group, expected] of cases) {
    const [op] = toOperations([baseOperation({ group })])
    expect(op?.kind).toBe(expected)
  }
})

test('незнакомая группа банка даёт unknown, а не роняет сбор', () => {
  // банк вправе ввести новое значение в любой момент; операция должна
  // остаться видимой, а не пропасть и не сломать весь прогон
  const [op] = toOperations([baseOperation({ group: 'CRYPTO_STAKING' })])
  expect(op?.kind).toBe('unknown')
})

test('отсутствующая группа даёт unknown', () => {
  const withoutGroup = baseOperation()
  delete withoutGroup['group']
  const [op] = toOperations([withoutGroup])
  expect(op?.kind).toBe('unknown')
})

test('нестроковая группа даёт unknown, а не падение', () => {
  const [op] = toOperations([baseOperation({ group: 42 })])
  expect(op?.kind).toBe('unknown')
})
```

В `baseOperation` в том же файле добавить поле по умолчанию, рядом с `type`:

```typescript
    group: 'PAY',
```

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd collector && pnpm test`
Ожидание: FAIL — `op.kind` равен `undefined`.

- [ ] **Шаг 3: Поле в типе**

В `collector/src/plugins/tbank/types.ts`:

```typescript
/** Операция в том виде, в каком её принимает наше приложение. */
export interface CollectedOperation {
  occurred_at: string
  amount: string
  currency: string
  description: string
  external_id: string
  /** Вид операции в словаре приложения; словарь банка переводится здесь, в плагине. */
  kind: string
}
```

- [ ] **Шаг 4: Отображение**

В `collector/src/plugins/tbank/map.ts` рядом с остальными константами:

```typescript
// Единственное место в системе, где живёт словарь Т-Банка. Приложение работает
// своими терминами и про PAY/INTERNAL не знает: иначе знание об одном банке
// протекло бы в ядро домена и каждый новый банк правился бы там же.
const BANK_GROUP_TO_KIND: Record<string, string> = {
  PAY: 'purchase',
  TRANSFER: 'transfer_person',
  INTERNAL: 'transfer_self',
  CASH: 'cash',
  LOANREPAY: 'loan',
  INCOME: 'income',
}

// Незнакомая группа — не ошибка разбора: банк вправе ввести новое значение.
// Операция получает unknown и остаётся видимой в приложении
function resolveKind(item: Record<string, unknown>): string {
  const group = getStr(item, 'group')
  return (group && BANK_GROUP_TO_KIND[group]) ?? 'unknown'
}
```

И в возвращаемом объекте `toOperation` добавить поле:

```typescript
    kind: resolveKind(item),
```

- [ ] **Шаг 5: Счётчик неизвестных в выводе**

В `collector/src/runner/main.ts` в функции сбора, после получения операций,
посчитать неизвестные и напечатать, если они есть:

```typescript
    const unknownCount = operations.filter((op) => op.kind === 'unknown').length
    if (unknownCount > 0) {
      // не ошибка, но знать об этом надо: банк ввёл группу, которой мы не знаем
      console.log(`счёт ${appAccountId}: операций с неизвестным видом ${unknownCount}`)
    }
```

- [ ] **Шаг 6: Фикстура**

В `collector/tests/fixtures/operations.json` добавить каждой операции поле
`"group"`: для `op-1` — `"PAY"`, для `op-2` — `"INCOME"`, для `op-3` (той, что
со статусом FAILED) — `"PAY"`, для `op-4` — `"TRANSFER"`. Это держит фикстуру
похожей на реальный ответ банка, где поле есть у каждой операции.

- [ ] **Шаг 7: Прогнать и гейты**

Run: `cd collector && pnpm test && pnpm lint && pnpm build`
Ожидание: всё зелёное.

- [ ] **Шаг 8: Мутационная проверка**

Временно заменить `?? 'unknown'` на `?? 'purchase'` — должен покраснеть тест про
незнакомую группу. Вернуть как было. Если не краснеет — тест бесполезен,
переписать.

- [ ] **Шаг 9: Коммит**

```bash
git add collector/
git commit -m "Коллектор: словарь групп Т-Банка переводится в вид операции приложения"
```

---

## Task 5: Ручное переопределение «считать тратой»

**Files:**
- Modify: `backend/app/ledger/schemas.py`
- Modify: `backend/app/ledger/service.py`
- Test: `backend/tests/test_operation_kinds.py` (дополнить)
- Modify: `frontend/src/api/ledger.ts`
- Modify: `frontend/src/pages/TransactionsPage.tsx`
- Test: `frontend/src/pages/TransactionsPage.test.tsx` (создать)

- [ ] **Шаг 1: Падающие тесты бэкенда**

Дополнить `backend/tests/test_operation_kinds.py`:

```python
async def _first_transaction_id(client: AsyncClient, ws: str) -> str:
    listed = await client.get("/api/transactions", params={"workspace_id": ws})
    return str(listed.json()["items"][0]["id"])


async def test_override_returns_transfer_to_expenses(client: AsyncClient) -> None:
    """Перевод таксисту — по факту перевод, по смыслу поездка."""
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "transfer_person", "-450.00")
    await _post_kind(client, ws, acc, "transfer_self", "-5000.00")
    assert await _month_expenses_total(client, ws) == Decimal("450.00")

    txn_id = await _first_transaction_id(client, ws)
    resp = await client.patch(
        f"/api/transactions/{txn_id}",
        params={"workspace_id": ws},
        json={"spending_override": True},
    )
    assert resp.status_code == 200
    assert resp.json()["spending_override"] is True


async def test_override_removes_purchase_from_expenses(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "purchase", "-100.00")
    txn_id = await _first_transaction_id(client, ws)

    await client.patch(
        f"/api/transactions/{txn_id}",
        params={"workspace_id": ws},
        json={"spending_override": False},
    )
    assert await _month_expenses_total(client, ws) == Decimal(0)


async def test_override_survives_rule_change(client: AsyncClient) -> None:
    """Решение человека и вид операции — разные поля: вид не затирается."""
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "transfer_self", "-5000.00")
    txn_id = await _first_transaction_id(client, ws)

    await client.patch(
        f"/api/transactions/{txn_id}",
        params={"workspace_id": ws},
        json={"spending_override": True},
    )
    listed = await client.get("/api/transactions", params={"workspace_id": ws})
    item = listed.json()["items"][0]
    assert item["operation_kind"] == "transfer_self"
    assert item["spending_override"] is True
```

Ручка правки проверена: `PATCH /api/transactions/{transaction_id}`
(`app/ledger/router.py:182`).

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_operation_kinds.py -q`
Ожидание: FAIL — поле `spending_override` не принимается.

- [ ] **Шаг 3: Поле в схеме правки**

В `backend/app/ledger/schemas.py` в `TransactionUpdate` добавить:

```python
    spending_override: bool | None = None
```

- [ ] **Шаг 4: Применение в сервисе**

В `backend/app/ledger/service.py` в `update_transaction`, рядом с остальными
полями:

```python
    # именно model_fields_set, а не "is not None": здесь null — осмысленное
    # значение «сбросить решение, пусть снова решает правило по виду операции».
    # Обычная проверка на None их не различает, и сбросить переопределение
    # через API стало бы невозможно
    if "spending_override" in payload.model_fields_set:
        transaction.spending_override = payload.spending_override
```

Тестом закрыть и сброс:

```python
async def test_override_can_be_reset_to_rule(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    await _post_kind(client, ws, acc, "transfer_self", "-5000.00")
    txn_id = await _first_transaction_id(client, ws)

    await client.patch(
        f"/api/transactions/{txn_id}",
        params={"workspace_id": ws},
        json={"spending_override": True},
    )
    assert await _month_expenses_total(client, ws) == Decimal("5000.00")

    await client.patch(
        f"/api/transactions/{txn_id}",
        params={"workspace_id": ws},
        json={"spending_override": None},
    )
    assert await _month_expenses_total(client, ws) == Decimal(0)
```

- [ ] **Шаг 5: Прогнать**

Run: `cd backend && uv run pytest tests/test_operation_kinds.py -q`
Ожидание: PASS.

- [ ] **Шаг 6: Тип на фронте**

В `frontend/src/api/ledger.ts` в интерфейс `Transaction` добавить:

```typescript
  operation_kind: string
  spending_override: boolean | null
  // считает бэкенд тем же правилом, что и статистика: повторять его здесь нельзя,
  // иначе появится вторая реализация и разойдётся с первой
  counts_as_spending: boolean
```

И функцию правки (рядом с существующими вызовами API операций):

```typescript
export const setSpendingOverride = (ws: string, id: string, value: boolean) =>
  api<Transaction>(`/api/transactions/${id}?${q(ws)}`, {
    method: 'PATCH',
    body: JSON.stringify({ spending_override: value }),
  })
```

**Проверить:** как в этом файле устроены остальные мутирующие вызовы (заголовки,
хелпер `q`) — повторить их устройство, а не изобретать своё.

- [ ] **Шаг 7: Пометка и переключатель в таблице**

В `frontend/src/pages/TransactionsPage.tsx` добавить словарь подписей рядом с
другими константами модуля:

```typescript
// подписи для человека; сам словарь видов задаёт бэкенд
const KIND_LABELS: Record<string, string> = {
  transfer_person: 'Перевод',
  transfer_self: 'Между счетами',
  cash: 'Наличные',
  loan: 'Кредит',
  unknown: 'Вид неизвестен',
}
```

**Копий старого правила две, и обе надо убрать.**

Первая — на бэкенде: `backend/app/ledger/service.py:410`,
`is_transfer=t.transfer_group_id is not None` в сборке ленты «Последние
операции» на дашборде. Это то самое условие, от которого избавляется Task 2, и
оно осталось нетронутым. Следствие видно на экране: односторонний
`transfer_self` из импорта ушёл из расходов месяца, но в ленте показывается
обычной строкой без пометки, а категорию не получит никогда (он исключён из
`list_uncategorized`) — в колонке «Категория» у него навсегда «—» без
объяснения. Цифры сходятся, а экран противоречит сам себе.

Вторая — на фронте: `frontend/src/pages/CategoryCell.tsx:12`,
`if (txn.transfer_group_id) return <Text>Перевод</Text>` — собственное решение
фронта о том, предлагать ли выбор категории. Односторонний `transfer_self` оно
не увидит по той же причине: `transfer_group_id` у такой операции пустой.

Обе заменить на общее правило: на бэкенде — `counts_in_stats()`, на фронте —
`!t.counts_as_spending`. Тестом закрыть, что импортированный `transfer_self`
получает пометку в ленте дашборда.

**Новое правило на фронте не повторяем** по той же причине: вторая реализация
разойдётся с бэкендом при первой же правке. Бэкенд отдаёт уже посчитанное
значение — в `TransactionOut` (шаг 3 этой задачи) добавить поле

```python
    counts_as_spending: bool
```

и заполнять его в месте сборки ответа тем же правилом, что и запросы статистики —
через общую функцию, чтобы источник остался один. Фронт просто читает
`t.counts_as_spending`.

В строку таблицы, в ячейку с суммой, добавить пометку под суммой:

```tsx
              <Table.Td ta="right">
                {formatMoney(t.amount, t.currency)}
                {KIND_LABELS[t.operation_kind] && (
                  <Text size="xs" c="dimmed">{KIND_LABELS[t.operation_kind]}</Text>
                )}
              </Table.Td>
```

И кнопку в последнюю ячейку, рядом с «Удалить»:

```tsx
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => overrideMut.mutate({ id: t.id, value: !t.counts_as_spending })}
                >
                  {t.counts_as_spending ? 'Не считать тратой' : 'Считать тратой'}
                </Button>
```

Мутация рядом с `deleteMut`:

```typescript
  const overrideMut = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      setSpendingOverride(ws, id, value),
    onSuccess: invalidate,
  })
```

**Проверить:** как называется функция инвалидации в этом файле (`invalidate` или
иначе) и как устроены соседние мутации — повторить их устройство.

- [ ] **Шаг 8: Тест фронта**

Создать `frontend/src/pages/TransactionsPage.test.tsx`. Ограничения проекта
соблюдать точно: линтер **oxlint**, `@testing-library/jest-dom` **нет** (никаких
`toBeInTheDocument`, только `toBeDefined()` / `toBeNull()`), глобалы vitest
выключены — импортировать `{ expect, test, vi }` явно, компонент оборачивать в
`<MantineProvider>`. Устройство теста скопировать с
`frontend/src/pages/ImportPage.test.tsx`.

Проверить два случая: у операции вида `transfer_self` показана пометка «Между
счетами» и кнопка «Считать тратой»; у операции вида `purchase` кнопка называется
«Не считать тратой».

- [ ] **Шаг 9: Прогоны**

Run: `cd backend && uv run pytest -q`
Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Ожидание: всё зелёное.

- [ ] **Шаг 10: Коммит**

```bash
git add backend/app/ledger/ backend/tests/test_operation_kinds.py frontend/src/
git commit -m "Учёт: ручное переопределение «считать тратой» и пометка вида операции"
```

---

## Task 6: Правила «описание → категория»

**Files:**
- Modify: `backend/app/ledger/models.py`
- Create: `backend/alembic/versions/0010_description_rules.py`
- Modify: `backend/app/ledger/repository.py`
- Modify: `backend/app/ledger/service.py`
- Modify: `backend/app/imports/service.py`
- Test: `backend/tests/test_description_rules.py`

**Зачем.** Белый список контрагентов: перевод близкому автоматически получает
свою категорию. Та же таблица позже примет выученные правила категоризации —
поэтому она одна, а не две.

- [ ] **Шаг 1: Падающие тесты**

Создать `backend/tests/test_description_rules.py`:

```python
import uuid
from decimal import Decimal

from httpx import AsyncClient

from app.ledger.service import normalize_description

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


def test_normalization_is_simple_and_predictable() -> None:
    # намеренно простая: вычищать «шум» банковских описаний регулярками значит
    # подгонять систему под один банк
    assert normalize_description("  Анастасия   С.  ") == "анастасия с."
    assert normalize_description("КОФЕЙНЯ") == "кофейня"


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def _expense_category_id(client: AsyncClient, ws: str) -> str:
    cats = await client.get("/api/categories", params={"workspace_id": ws})
    return str(next(c["id"] for c in cats.json() if c["kind"] == "expense"))


async def _import_one(client: AsyncClient, ws: str, acc: str, description: str) -> None:
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "test_collector",
            "operations": [
                {
                    "occurred_at": "2026-09-01",
                    "amount": "-450.00",
                    "currency": "RUB",
                    "description": description,
                    "external_id": f"op-{description}",
                    "kind": "transfer_person",
                }
            ],
        },
    )
    import_id = resp.json()["import_id"]
    await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})


async def test_rule_sets_category_on_import(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    cat = await _expense_category_id(client, ws)
    await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "Анастасия С.", "category_id": cat},
    )

    await _import_one(client, ws, acc, "анастасия   с.")

    listed = await client.get("/api/transactions", params={"workspace_id": ws})
    item = listed.json()["items"][0]
    assert item["category_id"] == cat
    # правило подтвердил человек, а не эту конкретную операцию
    assert item["category_confirmed"] is False


async def test_import_without_rule_leaves_category_empty(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    await _import_one(client, ws, acc, "Незнакомый контрагент")

    listed = await client.get("/api/transactions", params={"workspace_id": ws})
    assert listed.json()["items"][0]["category_id"] is None


async def test_rules_are_isolated_between_workspaces(client: AsyncClient) -> None:
    ws_a, acc_a = await _ws_and_account(client)
    cat_a = await _expense_category_id(client, ws_a)
    await client.post(
        "/api/description-rules",
        params={"workspace_id": ws_a},
        json={"text": "Анастасия С.", "category_id": cat_a},
    )

    client.cookies.clear()
    await client.post("/api/auth/register", json=BOB)
    me = await client.get("/api/me")
    ws_b = str(me.json()["workspaces"][0]["id"])
    acc_b = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws_b},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]

    await _import_one(client, ws_b, acc_b, "Анастасия С.")
    listed = await client.get("/api/transactions", params={"workspace_id": ws_b})
    assert listed.json()["items"][0]["category_id"] is None

    # и чужой workspace не отдаётся по прямому запросу
    foreign = await client.get("/api/description-rules", params={"workspace_id": ws_a})
    assert foreign.status_code == 403


async def test_duplicate_rule_rejected(client: AsyncClient) -> None:
    ws, _ = await _ws_and_account(client)
    cat = await _expense_category_id(client, ws)
    body = {"text": "Анастасия С.", "category_id": cat}
    assert (
        await client.post("/api/description-rules", params={"workspace_id": ws}, json=body)
    ).status_code == 201
    # то же описание в другом регистре нормализуется в тот же ключ
    again = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "анастасия с.", "category_id": cat},
    )
    assert again.status_code == 409
```

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_description_rules.py -q`
Ожидание: FAIL — нет `normalize_description` и нет ручки `/api/description-rules`.

- [ ] **Шаг 3: Модель**

В `backend/app/ledger/models.py` добавить класс после `Transaction`:

```python
class DescriptionRule(Base):
    """Правило «описание операции → категория».

    Одна таблица и для белого списка контрагентов (задаётся человеком), и для
    будущих выученных правил категоризации: это одно и то же по сути, различает
    их колонка source.
    """

    __tablename__ = "description_rules"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    normalized_text: Mapped[str] = mapped_column(String(300))
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("categories.id"))
    # manual — задано человеком, learned — выучено из подтверждений
    source: Mapped[str] = mapped_column(String(20), default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("workspace_id", "normalized_text", name="uq_description_rules_text"),
    )
```

Добавить `UniqueConstraint` в импорты из `sqlalchemy`, если его там нет.

- [ ] **Шаг 4: Миграция**

Создать `backend/alembic/versions/0010_description_rules.py`:

```python
"""Правила «описание операции → категория»"""

import sqlalchemy as sa

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "description_rules",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("normalized_text", sa.String(300), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.String(20), nullable=False, server_default=sa.text("'manual'")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        # правило без категории бессмысленно: удалили категорию — удалилось правило
        sa.ForeignKeyConstraint(["category_id"], ["categories.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "normalized_text", name="uq_description_rules_text"),
    )


def downgrade() -> None:
    op.drop_table("description_rules")
```

- [ ] **Шаг 5: Нормализация и repository**

В `backend/app/ledger/service.py` рядом с другими функциями модуля:

```python
def normalize_description(text: str) -> str:
    """Ключ правила. Намеренно простая нормализация: регистр и лишние пробелы.

    Вычищать «шум» банковских описаний регулярками — подгонка под конкретный
    банк, а словарь у каждого свой.
    """
    return " ".join(text.split()).lower()
```

В `backend/app/ledger/repository.py`:

```python
async def find_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, normalized_text: str
) -> DescriptionRule | None:
    return await db.scalar(
        select(DescriptionRule).where(
            DescriptionRule.workspace_id == workspace_id,
            DescriptionRule.normalized_text == normalized_text,
        )
    )


async def list_description_rules(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[DescriptionRule]:
    rows = await db.execute(
        select(DescriptionRule)
        .where(DescriptionRule.workspace_id == workspace_id)
        .order_by(DescriptionRule.created_at.desc())
    )
    return list(rows.scalars().all())


def add_description_rule(db: AsyncSession, rule: DescriptionRule) -> None:
    db.add(rule)
```

Добавить `DescriptionRule` в импорт моделей в начале файла.

- [ ] **Шаг 6: Сервис правил и применение при импорте**

В `backend/app/ledger/service.py`:

```python
class DuplicateRuleError(Exception):
    """Правило для такого описания уже есть."""


async def create_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, text: str, category_id: uuid.UUID
) -> DescriptionRule:
    normalized = normalize_description(text)
    if await repository.find_description_rule(db, workspace_id, normalized) is not None:
        raise DuplicateRuleError
    category = await repository.get_category(db, workspace_id, category_id)
    if category is None:
        raise NotFoundError
    rule = DescriptionRule(
        workspace_id=workspace_id,
        normalized_text=normalized,
        category_id=category_id,
        source="manual",
    )
    repository.add_description_rule(db, rule)
    await db.commit()
    return rule


async def category_for_description(
    db: AsyncSession, workspace_id: uuid.UUID, description: str | None
) -> uuid.UUID | None:
    """Категория по правилу для описания операции, если правило есть."""
    if not description:
        return None
    rule = await repository.find_description_rule(
        db, workspace_id, normalize_description(description)
    )
    return None if rule is None else rule.category_id
```

Исключение `NotFoundError` уже объявлено в этом модуле
(`app/ledger/service.py:25`) — новое заводить не нужно.

В `backend/app/imports/service.py` в подтверждении импорта, перед вызовом
`post_transaction`, взять категорию по правилу и передать её:

```python
        rule_category_id = await ledger_service.category_for_description(
            db, workspace_id, op.description
        )
```

и в самом вызове заменить `category_id=None` на:

```python
            category_id=rule_category_id,
```

- [ ] **Шаг 7: Прогнать — часть тестов ещё красная**

Run: `cd backend && uv run pytest tests/test_description_rules.py -q`
Ожидание: тесты про нормализацию и про применение правила зелёные; тесты,
которым нужна ручка `/api/description-rules`, красные — её добавляет Task 7.

- [ ] **Шаг 8: Коммит**

```bash
git add backend/app/ledger/ backend/app/imports/service.py \
  backend/alembic/versions/0010_description_rules.py backend/tests/test_description_rules.py
git commit -m "Учёт: правила «описание → категория» и их применение при импорте"
```

---

## Task 7: Управление правилами через API

**Files:**
- Modify: `backend/app/ledger/schemas.py`
- Modify: `backend/app/ledger/router.py`
- Test: `backend/tests/test_description_rules.py` (уже написаны в Task 6)

**Зачем.** Экрана управления правилами пока не делаем — их единицы, и к
интерфейсу есть отдельный большой вопрос. По образцу токенов коллектора: сначала
API, экран появится, когда правил станет много.

- [ ] **Шаг 1: Схемы**

В `backend/app/ledger/schemas.py`:

```python
class DescriptionRuleCreate(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    category_id: uuid.UUID


class DescriptionRuleOut(BaseModel):
    id: uuid.UUID
    normalized_text: str
    category_id: uuid.UUID
    source: str
```

- [ ] **Шаг 2: Ручки**

В `backend/app/ledger/router.py`:

```python
@router.get("/description-rules")
async def list_description_rules(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[DescriptionRuleOut]:
    rules = await service.list_description_rules(db, workspace_id)
    return [
        DescriptionRuleOut(
            id=r.id,
            normalized_text=r.normalized_text,
            category_id=r.category_id,
            source=r.source,
        )
        for r in rules
    ]


@router.post("/description-rules", status_code=201)
async def create_description_rule(
    payload: DescriptionRuleCreate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> DescriptionRuleOut:
    try:
        rule = await service.create_description_rule(
            db, workspace_id, payload.text, payload.category_id
        )
    except DuplicateRuleError:
        raise HTTPException(status_code=409, detail="Правило для такого описания уже есть") from None
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Категория не найдена") from None
    return DescriptionRuleOut(
        id=rule.id,
        normalized_text=rule.normalized_text,
        category_id=rule.category_id,
        source=rule.source,
    )


@router.delete("/description-rules/{rule_id}", status_code=204)
async def delete_description_rule(
    rule_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    await service.delete_description_rule(db, workspace_id, rule_id)
```

Добавить в `backend/app/ledger/service.py` недостающие функции:

```python
async def list_description_rules(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[DescriptionRule]:
    return await repository.list_description_rules(db, workspace_id)


async def delete_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, rule_id: uuid.UUID
) -> None:
    rule = await repository.get_description_rule(db, workspace_id, rule_id)
    if rule is not None:
        await repository.delete_description_rule(db, rule)
        await db.commit()
```

И в `backend/app/ledger/repository.py` — сам запрос: по правилам проекта в базу
ходит только repository, фильтр по `workspace_id` тоже живёт здесь.

```python
async def get_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, rule_id: uuid.UUID
) -> DescriptionRule | None:
    return await db.scalar(
        select(DescriptionRule).where(
            DescriptionRule.id == rule_id,
            DescriptionRule.workspace_id == workspace_id,
        )
    )


async def delete_description_rule(db: AsyncSession, rule: DescriptionRule) -> None:
    await db.delete(rule)
```

- [ ] **Шаг 3: Прогнать**

Run: `cd backend && uv run pytest tests/test_description_rules.py -q`
Ожидание: PASS, все тесты.

- [ ] **Шаг 4: Гейты**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`
Ожидание: всё зелёное.

- [ ] **Шаг 5: Мутационная проверка**

Убрать фильтр по `workspace_id` в `find_description_rule` — должен покраснеть
тест изоляции. Вернуть.

**Известно заранее: в исходном виде этот тест мутацию не ловил.** Правило чужого
workspace ссылается и на чужую категорию, а её отсекает следующая проверка —
`get_category` тоже фильтрует по workspace. Защита эшелонированная, и это
хорошо, но тест при этом ничего не гарантировал: убери фильтр в одном месте, и
он останется зелёным за счёт другого. При работе над Task 6 в тест добавлена
прямая проверка repository-слоя, после которой мутация краснеет. Убедись, что
она на месте, и не считай зелёный прогон доказательством, пока не проверил
мутацией.

- [ ] **Шаг 6: Коммит**

```bash
git add backend/app/ledger/
git commit -m "Учёт: управление правилами описаний через API"
```

---

## Task 8: Пересбор данных и README

**Files:**
- Modify: `collector/README.md`
- Modify: `README.md`

- [ ] **Шаг 1: Описать пересбор в README коллектора**

В `collector/README.md` добавить раздел о том, что при появлении новых полей в
разборе (например, вида операции) старые операции повторным сбором **не
обновляются**: дедуп по идентификатору банка считает их дублями. Чтобы собрать
заново, нужно удалить операции счёта в приложении и запустить сбор снова.

- [ ] **Шаг 2: Дополнить корневой README**

В `README.md` в разделе «Что реализовано» добавить пункт про то, что операции
делятся на траты и движения денег, переводы между своими счетами и наличные в
статистику расходов не попадают, вид операции определяет коннектор банка.

- [ ] **Шаг 3: Ручная проверка на живых данных**

Выполнить (стек поднят, `docker compose up -d`):

1. удалить операции счёта Т-Банка в приложении;
2. запустить коллектор: `cd collector && pnpm collect`;
3. открыть дашборд и убедиться, что расходы месяца перестали включать
   «Пополнение Кубышки» и «Между своими счетами»;
4. проверить, что в ленте у переводов появилась пометка вида;
5. нажать «Считать тратой» у одного перевода и убедиться, что сумма расходов
   выросла.

Результат зафиксировать в отчёте: числа до и после.

- [ ] **Шаг 4: Коммит**

```bash
git add README.md collector/README.md
git commit -m "Документация: виды операций и пересбор данных после смены разбора"
```

---

## Финальная проверка

- [ ] **Бэкенд:** из `backend/` — `uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`. Всё зелёное, регрессий нет.
- [ ] **Коллектор:** из `collector/` — `pnpm test && pnpm lint && pnpm build`.
- [ ] **Фронтенд:** из `frontend/` — `pnpm test && pnpm lint && pnpm build`.
- [ ] **Миграции:** применяются на чистой базе и откатываются — `uv run alembic upgrade head`, затем `uv run alembic downgrade 0008` и снова `upgrade head`.
- [ ] **Живой прогон** по шагам Task 8.
