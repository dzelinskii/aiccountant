# Остаток по счёту — план реализации

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ — использовать
> superpowers:subagent-driven-development (рекомендуется) или
> superpowers:executing-plans. Шаги помечены чекбоксами.

**Цель:** показывать по счёту остаток, совпадающий с действительностью, и делать
понятным, какой именно счёт человек видит.

**Архитектура:** остаток берётся у того, кто его сообщил. Коллектор присылает
остаток банка вместе с операциями; приложение применяет его при подтверждении
импорта. Счета, о которых никто не сообщает, человек правит сам — задаёт текущий
остаток, приложение хранит поправку к сумме операций. Метка счёта — последние
четыре цифры карт либо собственный тип счёта.

**Стек:** FastAPI, SQLAlchemy 2 async, Alembic, Pydantic v2, pytest +
testcontainers; коллектор — Node + TypeScript, vitest; фронтенд — React 19,
Mantine, vitest.

**Спека:** `docs/superpowers/specs/2026-09-03-account-balance-design.md`

**Ветка:** `account-balance` (уже создана).

---

## Карта файлов

**Бэкенд:**

- `app/ledger/models.py` — четыре поля у `Account`.
- `alembic/versions/0011_account_balance.py` — **создать.**
- `app/ledger/balance.py` — **создать.** Чистые функции: какой остаток
  показывать и какую поправку сохранить. Отдельный модуль, потому что правилом
  пользуются и чтение счетов, и правка, и применение из импорта — а
  `service.py` уже большой.
- `app/ledger/repository.py` — отдать сумму операций отдельно от остатка.
- `app/ledger/service.py` — правка остатка, применение сообщённого остатка.
- `app/ledger/schemas.py` — поля в `AccountOut` и `AccountUpdate`.
- `app/ledger/router.py` — сборка ответа.
- `app/imports/schemas.py` — необязательный блок про счёт в теле импорта.
- `app/imports/service.py` — применение при подтверждении.

**Коллектор:**

- `collector/src/plugins/tbank/types.ts` — остаток и метки у `CollectedAccount`.
- `collector/src/plugins/tbank/map.ts` — чтение `moneyAmount` и `cards[]`.
- `collector/src/runner/push.ts` — блок про счёт в теле запроса.
- `collector/src/runner/main.ts` — передача данных счёта в отправку.

**Фронтенд:**

- `frontend/src/api/ledger.ts` — поля счёта, правка остатка.
- `frontend/src/pages/AccountsPage.tsx` — метка, момент, правка.
- `frontend/src/pages/DashboardPage.tsx` — метка и момент рядом с остатком.

---

## Известное ограничение, которое надо держать в голове

`pushOperations` не отправляет ничего, когда операций за период нет, а
`POST /api/imports/parsed` требует минимум одну операцию. Значит **в день без
операций остаток не обновится** — на экране останется прежнее число с прежней
отметкой времени.

Это принято сознательно: заводить ради такого случая отдельный эндпоинт дороже,
чем польза. Отметка времени рядом с остатком как раз и делает ситуацию честной —
человек видит, на какой момент число верно. В README коллектора это надо
написать словами.

---

## Task 1: Поля счёта и правило остатка

**Files:**
- Create: `backend/app/ledger/balance.py`
- Modify: `backend/app/ledger/models.py`
- Create: `backend/alembic/versions/0011_account_balance.py`
- Test: `backend/tests/test_account_balance.py`

- [ ] **Шаг 1: Правило одной функцией**

Создать `backend/app/ledger/balance.py`:

```python
from decimal import Decimal


def visible_balance(
    reported: Decimal | None, adjustment: Decimal, operations_sum: Decimal
) -> Decimal:
    """Остаток, который видит человек.

    Сообщённый источником остаток главенствует: банк знает лучше нас. Если
    источника нет — счёт ведётся руками, и остаток складывается из суммы
    операций и поправки, которую человек задал, когда пересчитывал деньги.
    """
    if reported is not None:
        return reported
    return adjustment + operations_sum


def adjustment_for(desired: Decimal, operations_sum: Decimal) -> Decimal:
    """Поправка, при которой видимый остаток станет равен заданному.

    Человек правит текущий остаток, а не «начальное значение»: пересчитал
    кошелёк — поставил число. Разницу с суммой операций храним мы, и в
    интерфейс это понятие не выносится.
    """
    return desired - operations_sum
```

- [ ] **Шаг 2: Падающие тесты**

Создать `backend/tests/test_account_balance.py`:

```python
from decimal import Decimal

from app.ledger.balance import adjustment_for, visible_balance


def test_reported_balance_wins() -> None:
    # источник сообщил остаток — он и показывается, поправка не участвует
    assert visible_balance(Decimal("100.00"), Decimal("999.00"), Decimal("-50.00")) == Decimal(
        "100.00"
    )


def test_without_reported_sum_and_adjustment() -> None:
    assert visible_balance(None, Decimal("5000.00"), Decimal("-200.00")) == Decimal("4800.00")


def test_without_reported_and_without_adjustment() -> None:
    # поведение до этой задачи: остаток равен сумме операций
    assert visible_balance(None, Decimal(0), Decimal("-122515.28")) == Decimal("-122515.28")


def test_adjustment_makes_desired_visible() -> None:
    operations = Decimal("-200.00")
    adjustment = adjustment_for(Decimal("4900.00"), operations)
    assert visible_balance(None, adjustment, operations) == Decimal("4900.00")


def test_reported_zero_is_not_absent() -> None:
    # ноль — законный остаток, а не «источник промолчал»
    assert visible_balance(Decimal(0), Decimal("777.00"), Decimal("13.00")) == Decimal(0)
```

- [ ] **Шаг 3: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_account_balance.py -q`
Ожидание: FAIL — модуля `app.ledger.balance` нет.

- [ ] **Шаг 4: Поля модели**

В `backend/app/ledger/models.py` в класс `Account`, после `is_archived`:

```python
    # остаток, сообщённый источником (коллектором банка), и момент, на который
    # он верен. Пусто — источника у счёта нет, счёт ведётся руками
    reported_balance: Mapped[Decimal | None] = mapped_column(Numeric(20, 4), nullable=True)
    reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # поправка к сумме операций для счетов без источника: человек задаёт текущий
    # остаток, разницу храним здесь. В интерфейс это понятие не выносится
    balance_adjustment: Mapped[Decimal] = mapped_column(
        Numeric(20, 4), default=Decimal(0), server_default=text("0")
    )
    # последние четыре цифры карт счёта; пусто у счетов без карт
    card_masks: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default=text("'[]'"))
```

Проверено: `Numeric`, `DateTime`, `text`, `Decimal`, `datetime` в этом файле уже
импортированы. Не хватает только одного — добавить:

```python
from sqlalchemy.dialects.postgresql import JSONB
```

- [ ] **Шаг 5: Миграция**

Создать `backend/alembic/versions/0011_account_balance.py`, `revision = "0011"`,
`down_revision = "0010"`. Формат бери из `0010_description_rules.py`.

```python
def upgrade() -> None:
    op.add_column("accounts", sa.Column("reported_balance", sa.Numeric(20, 4), nullable=True))
    op.add_column(
        "accounts", sa.Column("reported_at", sa.DateTime(timezone=True), nullable=True)
    )
    # существующие счета продолжают показывать сумму операций: поправка нулевая
    op.add_column(
        "accounts",
        sa.Column(
            "balance_adjustment",
            sa.Numeric(20, 4),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "accounts",
        sa.Column(
            "card_masks",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("accounts", "card_masks")
    op.drop_column("accounts", "balance_adjustment")
    op.drop_column("accounts", "reported_at")
    op.drop_column("accounts", "reported_balance")
```

Нужен импорт `from sqlalchemy.dialects import postgresql`.

- [ ] **Шаг 6: Прогнать**

Run: `cd backend && uv run pytest tests/test_account_balance.py -q`
Ожидание: PASS, 5 тестов.

- [ ] **Шаг 7: Миграция на базе с данными**

Поднять отдельный контейнер Postgres на свободном порту (боевую базу
запущенного стека `moneyrain-*` не трогать), накатить `0010`, вставить счёт и
пару транзакций, накатить `0011`, проверить: `balance_adjustment` равен нулю,
`card_masks` равен `[]`, `reported_balance` и `reported_at` пусты, транзакции
целы. Затем `downgrade 0010` и снова `upgrade head`. Контейнер удалить.

- [ ] **Шаг 8: Коммит**

```bash
git add backend/app/ledger/balance.py backend/app/ledger/models.py \
  backend/alembic/versions/0011_account_balance.py backend/tests/test_account_balance.py
git commit -m "Учёт: поля остатка у счёта и правило его вычисления"
```

---

## Task 2: Остаток доезжает до счёта

**Files:**
- Modify: `backend/app/ledger/repository.py`
- Modify: `backend/app/ledger/service.py`
- Modify: `backend/app/ledger/schemas.py`
- Modify: `backend/app/ledger/router.py`
- Test: `backend/tests/test_account_balance.py` (дополнить)

**Зачем.** Сейчас `list_accounts_with_balance` и `account_balance` возвращают
сумму транзакций и называют её остатком. Нужно разделить: сумма операций — факт
о транзакциях, остаток — то, что показывает правило из Task 1.

- [ ] **Шаг 1: Падающие тесты**

Дополнить `backend/tests/test_account_balance.py`. Хелперы регистрации и
создания счёта бери из `tests/test_operation_kinds.py`, стиль — оттуда же.

Покрыть:

1. счёт без операций и без сообщённого остатка показывает `0.00`;
2. после операции на `-100.00` показывает `-100.00` (поведение не изменилось);
3. в ответе есть поля `reported_at` (пусто) и `card_masks` (пустой список).

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_account_balance.py -q`
Ожидание: FAIL — в ответе нет `reported_at` и `card_masks`.

- [ ] **Шаг 3: Repository отдаёт сумму операций**

В `backend/app/ledger/repository.py` переименовать смысл, а не только имя: обе
функции считают **сумму операций**, а не остаток.

`list_accounts_with_balance` → `list_accounts_with_operations_sum`,
`account_balance` → `account_operations_sum`. Тела не меняются.

Найти все вызовы (`grep -rn "list_accounts_with_balance\|account_balance" app/`)
и поправить. Ожидаются `service.list_accounts`, `service.update_account` и,
возможно, дашборд.

- [ ] **Шаг 4: Сервис возвращает видимый остаток**

В `backend/app/ledger/service.py` там, где раньше возвращалась сумма операций,
считать остаток через `visible_balance` из `app.ledger.balance`:

```python
from app.ledger.balance import visible_balance
```

и в `list_accounts` / `update_account` подставлять
`visible_balance(account.reported_balance, account.balance_adjustment, operations_sum)`.

- [ ] **Шаг 5: Схема**

В `backend/app/ledger/schemas.py` в `AccountOut` после `balance`:

```python
    # момент, на который верен остаток от источника; пусто — счёт ведётся
    # руками, и остаток считается по операциям
    reported_at: datetime | None
    # последние четыре цифры карт; пусто у счетов без карт
    card_masks: list[str]
```

Нужен импорт `datetime`.

В `backend/app/ledger/router.py` в `_account_out` добавить оба поля.

- [ ] **Шаг 6: Прогнать**

Run: `cd backend && uv run pytest -q`
Ожидание: всё зелёное, регрессий нет.

- [ ] **Шаг 7: Коммит**

```bash
git add backend/app/ledger/ backend/tests/test_account_balance.py
git commit -m "Учёт: сумма операций и остаток счёта — разные величины"
```

---

## Task 3: Приём остатка от коллектора

**Files:**
- Modify: `backend/app/imports/schemas.py`
- Modify: `backend/app/imports/service.py`
- Test: `backend/tests/test_account_balance.py` (дополнить)

- [ ] **Шаг 1: Падающие тесты**

Дополнить `backend/tests/test_account_balance.py`. Создавать импорт через
`POST /api/imports/parsed`, подтверждать через
`POST /api/imports/{id}/commit` — как в `tests/test_operation_kinds.py`.

Покрыть:

1. импорт с блоком счёта, где остаток `"12345.67"`: **до** подтверждения счёт
   показывает старое значение, **после** — `12345.67`;
2. `reported_at` после подтверждения не пуст;
3. импорт **без** блока счёта остаток не трогает;
4. метки карт из блока попадают в счёт;
5. остаток вне `NUMERIC(20,4)` (например `"1e30"`) даёт 422;
6. метка не из четырёх цифр (например `"12a4"` или `"123"`) даёт 422;
7. остаток числом JSON, а не строкой, даёт 422 — то же правило, что у сумм
   операций.

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_account_balance.py -q`
Ожидание: FAIL — блок счёта в теле игнорируется.

- [ ] **Шаг 3: Схема блока счёта**

В `backend/app/imports/schemas.py`:

```python
CARD_MASK = r"^[0-9]{4}$"
MAX_CARD_MASKS = 10


class ParsedAccountIn(BaseModel):
    """Что источник знает о самом счёте на момент сбора.

    Момент не присылаем: временем считается создание импорта — оно и есть
    момент обращения к банку, а доверять часам чужой машины незачем.
    """

    balance: Money
    card_masks: list[str] = Field(default_factory=list, max_length=MAX_CARD_MASKS)

    @field_validator("balance", mode="before")
    @classmethod
    def _balance_not_float(cls, value: object) -> object:
        if isinstance(value, float):
            # к моменту валидации разряды уже потеряны — то же правило, что
            # у сумм операций (см. ParsedOperationIn)
            raise ValueError("остаток должен быть строкой, а не числом JSON")
        return value

    @field_validator("card_masks")
    @classmethod
    def _masks_are_four_digits(cls, value: list[str]) -> list[str]:
        for mask in value:
            if not re.fullmatch(CARD_MASK, mask):
                raise ValueError("метка карты — ровно четыре цифры")
        return value
```

Нужен импорт `re`.

И в `ParsedImportIn` добавить поле:

```python
    # необязательный: разбор PDF-выписки про счёт ничего не знает
    account: ParsedAccountIn | None = None
```

- [ ] **Шаг 4: Сохранить блок в payload**

Блок нужен при **подтверждении**, а импорт подтверждается позже, поэтому его
надо положить в `parsed_payload` рядом с операциями — иначе он потеряется между
отправкой и подтверждением, ровно как это было с видом операции.

В `backend/app/imports/service.py` в `create_parsed_import` добавить в
`payload` ключ `"account"` со словарём `{"balance": str(...), "card_masks": [...]}`
(либо не добавлять вовсе, если блока не прислали). Деньги — строкой: JSONB не
хранит `Decimal`.

**Важно:** payload собирается **до** создания `Import`; дописывать в уже
присвоенный JSONB нельзя — SQLAlchemy не отследит правку на месте. В этом же
файле рядом есть комментарий об этом.

- [ ] **Шаг 5: Применить при подтверждении**

В `backend/app/imports/service.py` в `commit_from_import`, после создания
операций, взять блок из payload и применить к счёту через сервис учёта:

```python
        await ledger_service.apply_reported_balance(
            db, workspace_id, imp.account_id, balance, card_masks, imp.created_at
        )
```

В `backend/app/ledger/service.py` добавить:

```python
async def apply_reported_balance(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    balance: Decimal,
    card_masks: list[str],
    reported_at: datetime,
) -> None:
    """Остаток и метки от источника. Момент — время создания импорта: именно
    тогда коллектор и обращался к банку."""
    account = await repository.get_account(db, workspace_id, account_id)
    if account is None:
        raise NotFoundError
    account.reported_balance = balance
    account.reported_at = reported_at
    account.card_masks = card_masks
```

Коммит транзакции — там же, где коммитится подтверждение импорта, отдельного не
делать.

**Границы модулей:** `imports` зовёт `ledger.service`, во внутренности `ledger`
не лезет. После правок обязательно `uv run lint-imports`.

- [ ] **Шаг 6: Прогнать и гейты**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`
Ожидание: всё зелёное, 7 контрактов целы.

- [ ] **Шаг 7: Мутации**

- применять остаток при **отправке**, а не при подтверждении — должен покраснеть
  тест 1 (проверка «до подтверждения счёт показывает старое»);
- не класть блок в payload — должен покраснеть тест 1;
- принимать метку любой длины — должен покраснеть тест 6.

Каждую внести, проверить, **сразу вернуть**, проверить `git status`.

- [ ] **Шаг 8: Коммит**

```bash
git add backend/app/imports/ backend/app/ledger/service.py backend/tests/
git commit -m "Импорт: остаток и метки карт от источника применяются при подтверждении"
```

---

## Task 4: Ручная правка остатка

**Files:**
- Modify: `backend/app/ledger/schemas.py`
- Modify: `backend/app/ledger/service.py`
- Modify: `backend/app/ledger/router.py`
- Test: `backend/tests/test_account_balance.py` (дополнить)

**Зачем.** Счета, о которых никто не сообщает остаток — наличные, банк без
коллектора, — человек ведёт сам. Он правит **текущий** остаток: пересчитал
кошелёк, поставил число. Понятия «начальный остаток» в интерфейсе нет.

- [ ] **Шаг 1: Падающие тесты**

Дополнить `backend/tests/test_account_balance.py`:

1. у счёта с операцией на `-200.00` задали остаток `4900.00` — счёт показывает
   `4900.00`;
2. после этого добавили расход на `100.00` — счёт показывает `4800.00`
   (поправка осталась, остаток поехал вслед за операцией);
3. правка счёта, у которого есть сообщённый остаток, даёт **409** и остаток не
   меняется;
4. правка чужого счёта даёт 404;
5. правка остатка не задевает имя и архивность счёта.

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd backend && uv run pytest tests/test_account_balance.py -q`
Ожидание: FAIL — поле `balance` в правке не принимается.

- [ ] **Шаг 3: Схема**

В `backend/app/ledger/schemas.py` в `AccountUpdate`:

```python
    # текущий остаток, каким его видит человек; поправку считает бэкенд
    balance: Decimal | None = None
```

Нужен импорт `Decimal`, если его нет.

- [ ] **Шаг 4: Ошибка и применение**

В `backend/app/ledger/service.py`:

```python
class ReportedBalanceError(Exception):
    """У счёта есть остаток от источника — править его руками нельзя."""
```

И в `update_account`, рядом с остальными полями:

```python
    if payload.balance is not None:
        if account.reported_balance is not None:
            # следующий сбор всё равно перезапишет правку: предлагать её значит
            # обещать то, чего мы не сделаем
            raise ReportedBalanceError
        operations_sum = await repository.account_operations_sum(db, workspace_id, account_id)
        account.balance_adjustment = adjustment_for(payload.balance, operations_sum)
```

Импорт `adjustment_for` из `app.ledger.balance`.

**Порядок важен:** сумму операций читаем до `db.commit()`, но после того как
убедились, что править можно.

- [ ] **Шаг 5: Роутер**

В `backend/app/ledger/router.py` в ручке правки счёта:

```python
    except service.ReportedBalanceError:
        raise HTTPException(
            status_code=409, detail="Остаток счёта приходит от источника"
        ) from None
```

- [ ] **Шаг 6: Прогнать и гейты**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`
Ожидание: всё зелёное.

- [ ] **Шаг 7: Мутации**

- убрать проверку `reported_balance is not None` — должен покраснеть тест 3;
- считать поправку как `desired` вместо `desired - operations_sum` — должен
  покраснеть тест 2 (после добавления операции остаток уедет не туда).

Внести, проверить, **сразу вернуть**, проверить `git status`.

- [ ] **Шаг 8: Коммит**

```bash
git add backend/app/ledger/ backend/tests/test_account_balance.py
git commit -m "Учёт: ручная правка остатка у счетов без источника"
```

---

## Task 5: Коллектор отдаёт остаток и метки карт

**Files:**
- Modify: `collector/src/plugins/tbank/types.ts`
- Modify: `collector/src/plugins/tbank/map.ts`
- Modify: `collector/src/runner/push.ts`
- Modify: `collector/src/runner/main.ts`
- Test: `collector/src/plugins/tbank/map.test.ts`, `collector/src/runner/push.test.ts`
- Test: `collector/tests/fixtures/accounts.json`

**Факты о живом ответе банка** (замерено, не предполагается):

- `moneyAmount: {value, currency}`, где **`value` — строка**;
- `cards[]` есть у 5 счетов из 12; у одного счёта две карты; встречается карта со
  статусом `Заблокирована`; у карт есть признак `primary: boolean`;
- **номер карты банк отдаёт уже замаскированным**: 16 символов со звёздочками
  вида `5536••••••••1234`, не только цифры.

- [ ] **Шаг 1: Падающие тесты**

Дополнить `collector/src/plugins/tbank/map.test.ts`:

1. остаток берётся из `moneyAmount.value` **строкой** и не проходит через число;
2. счёт без `moneyAmount` даёт остаток `null`, а не падение — терять сбор из-за
   остатка нельзя;
3. метка — последние четыре символа номера карты;
4. карта со статусом `Заблокирована` в метки не попадает;
5. основная карта (`primary: true`) идёт первой;
6. счёт без карт даёт пустой список меток;
7. в метку не попадает ничего, кроме четырёх последних символов, — даже если
   номер пришёл длиннее или короче ожидаемого.

- [ ] **Шаг 2: Прогнать — падает**

Run: `cd collector && pnpm test`

- [ ] **Шаг 3: Тип**

В `collector/src/plugins/tbank/types.ts` в `CollectedAccount`:

```typescript
  /** Остаток строкой, как отдал банк; null — банк остатка не сообщил. */
  balance: string | null
  /** Последние четыре цифры карт счёта; пусто, если карт нет. */
  cardMasks: string[]
```

- [ ] **Шаг 4: Чтение в map.ts**

В `collector/src/plugins/tbank/map.ts` рядом с остальными константами:

```typescript
const MASK_LENGTH = 4
// Проверяем известное «нерабочее» значение, а не равенство «Активна»: заведи
// банк новый статус, и обратная проверка молча спрятала бы рабочую карту
const BLOCKED_CARD_STATUS = 'Заблокирована'
```

И функцию, собирающую метки: карты, кроме заблокированных, основная первой, от
каждой — последние четыре символа. Номер банк уже маскирует, так что полного
номера у нас нет; обрезка нужна, чтобы не тащить дальше лишнее.

В `toAccount` добавить `balance` и `cardMasks`.

- [ ] **Шаг 5: Отправка**

В `collector/src/runner/push.ts` — необязательный блок про счёт в теле запроса:
`{ balance, card_masks }`, и только когда остаток не `null`. Имена полей в теле —
как в договоре API (`card_masks`), внутри коллектора — как принято в TypeScript
(`cardMasks`).

В `collector/src/runner/main.ts` передать в `pushOperations` данные счёта: они
уже получены выше вызовом `fetchAccounts`, повторно ходить в банк не нужно.

- [ ] **Шаг 6: Фикстура**

В `collector/tests/fixtures/accounts.json` довести счета до формы живого ответа:
добавить `moneyAmount` со строковым `value` и блок `cards` — хотя бы один счёт с
двумя картами (одна заблокирована) и хотя бы один без карт.

Проверить, что существующие тесты по фикстуре не сломались.

- [ ] **Шаг 7: Тест отправки**

Дополнить `collector/src/runner/push.test.ts`: блок счёта уходит в теле; при
`balance === null` блока в теле **нет**.

- [ ] **Шаг 8: Прогоны и мутации**

Run: `cd collector && pnpm test && pnpm lint && pnpm build`

Мутации: включать заблокированные карты в метки — краснеет тест 4; отправлять
номер целиком вместо последних четырёх — краснеет тест 3; при отсутствии
`moneyAmount` бросать вместо `null` — краснеет тест 2.

Внести, проверить, **сразу вернуть**, проверить `git status`.

- [ ] **Шаг 9: Коммит**

```bash
git add collector/
git commit -m "Коллектор: остаток счёта и последние цифры карт"
```

---

## Task 6: Интерфейс

**Files:**
- Modify: `frontend/src/api/ledger.ts`
- Modify: `frontend/src/pages/AccountsPage.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Test: `frontend/src/pages/AccountsPage.test.tsx` (создать)

**Ограничения проекта, соблюдать точно:** линтер **oxlint**, не eslint. В тестах
**нет `@testing-library/jest-dom`** — никаких `toBeInTheDocument`, только
`.toBeDefined()` / `.toBeNull()`. Глобалы vitest выключены — импортировать
`{ expect, test, vi }` явно. Компоненты оборачивать в `<MantineProvider>`.
Устройство теста копировать с `frontend/src/pages/TransactionsPage.test.tsx`.

- [ ] **Шаг 1: Тип и вызов**

В `frontend/src/api/ledger.ts` добавить в интерфейс счёта `reported_at: string | null`
и `card_masks: string[]`, и функцию правки остатка. Устройство мутирующих
вызовов и хелпер query-строки посмотреть в этом же файле и повторить.

- [ ] **Шаг 2: Метка счёта**

Метка показывается рядом с названием:

- есть `card_masks` → «•• 1234», несколько — через запятую;
- пусто → подпись собственного типа счёта. Словарь подписей в
  `AccountsPage.tsx` уже есть (`TYPES`: Карта, Наличные, Накопления) — взять
  оттуда, не заводить второй.

- [ ] **Шаг 3: Момент рядом с остатком**

Если `reported_at` не пуст — показать «остаток на <дата и время>». Формат
человеческий, не ISO.

- [ ] **Шаг 4: Правка остатка**

Только если `reported_at` пуст. Поле ввода и сохранение; при ответе 409 показать
текст ошибки, а не молчать.

- [ ] **Шаг 5: Дашборд**

В `DashboardPage.tsx` рядом с остатком счёта показать метку и, если есть, момент.

- [ ] **Шаг 6: Тесты**

Создать `frontend/src/pages/AccountsPage.test.tsx`. Покрыть: счёт с масками
показывает «•• 1234»; счёт без масок показывает подпись типа; у счёта с
`reported_at` правка остатка не предлагается; у счёта без него — предлагается и
уходит с введённым значением.

- [ ] **Шаг 7: Прогоны**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`

- [ ] **Шаг 8: Коммит**

```bash
git add frontend/src/
git commit -m "Интерфейс: метка счёта, момент остатка и ручная правка"
```

---

## Task 7: Документация и живая проверка

**Files:**
- Modify: `collector/README.md`
- Modify: `README.md`

- [ ] **Шаг 1: README коллектора**

Описать, что коллектор передаёт остаток счёта и последние цифры карт, и что
**в день без операций остаток не обновится** — отправлять нечего, а отметка
времени рядом с остатком показывает, на какой момент число верно.

- [ ] **Шаг 2: Корневой README**

В разделе «Что реализовано» дополнить пункт про учёт: остаток берётся от
источника, счета без источника правятся вручную, счёт опознаётся по последним
цифрам карты.

- [ ] **Шаг 3: Живая проверка (делает владелец вместе с ассистентом)**

1. поднять стек, применить миграции;
2. запустить коллектор (потребуется вход в банк — код быстрого доступа);
3. подтвердить импорт;
4. убедиться, что остаток счёта совпадает с тем, что показывает банк, а рядом
   стоит отметка времени;
5. убедиться, что у счёта видны последние четыре цифры карты;
6. завести счёт «Наличные», задать остаток руками, добавить расход, проверить,
   что остаток уменьшился.

Числа до и после зафиксировать в отчёте.

- [ ] **Шаг 4: Коммит**

```bash
git add README.md collector/README.md
git commit -m "Документация: остаток счёта от источника и ручная правка"
```

---

## Финальная проверка

- [ ] **Бэкенд:** из `backend/` — `uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run lint-imports && uv run pytest -q`.
- [ ] **Коллектор:** из `collector/` — `pnpm test && pnpm lint && pnpm build`.
- [ ] **Фронтенд:** из `frontend/` — `pnpm test && pnpm lint && pnpm build`.
- [ ] **Миграция:** `upgrade head` → `downgrade 0010` → `upgrade head` на базе с данными.
- [ ] **Живой прогон** по шагам Task 7.
