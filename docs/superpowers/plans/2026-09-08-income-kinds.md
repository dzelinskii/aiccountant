# Не всякий приход — доход: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перестать называть доходом перекладывание денег между своими счетами, внесение наличных и переводы от людей — банк уже присылает признак, который их различает.

**Architecture:** Т-Банк присылает `group` и `subgroup`. Группа `INCOME` огрубляет: под ней лежат и переводы от людей, и движение своих денег. Подгруппа различает. В плагине появляется таблица уточнения на четыре строки, которая перекрывает решение по группе; где группа отвечает верно, таблица молчит. Бэкенд не меняется — все нужные виды в словаре уже есть.

**Tech Stack:** TypeScript / Node / vitest / oxlint.

**Спека:** `docs/superpowers/specs/2026-09-08-income-kinds-design.md`

---

## Структура файлов

| файл | ответственность |
| --- | --- |
| `collector/src/plugins/tbank/map.ts` (править) | таблица `BANK_SUBGROUP_TO_KIND`, уточнение в `resolveKind` |
| `collector/src/plugins/tbank/map.test.ts` (править) | поведение уточнения и деградации |
| `collector/src/runner/report.ts` (править) | счётчик приходов, оставшихся доходом |
| `collector/src/runner/report.test.ts` (править) | поведение счётчика |
| `collector/src/runner/main.ts` (править) | вызов счётчика |
| `README.md` (править) | приход от человека больше не доход |

Бэкенд, фронтенд и словарь видов операций (`backend/app/core/operation_kinds.py`) **не трогаются вовсе**: все нужные виды там уже есть.

Сейчас в наборе коллектора 157 тестов.

---

### Task 1: Подгруппа уточняет вид операции

**Files:**
- Modify: `collector/src/plugins/tbank/map.ts` (рядом с `BANK_GROUP_TO_KIND`, строка ~185)
- Test: `collector/src/plugins/tbank/map.test.ts`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `collector/src/plugins/tbank/map.test.ts`. Вспомогательная функция для сборки операции в файле уже есть — найди её и переиспользуй, не заводи вторую. Если её сигнатура не позволяет задать `group` и `subgroup`, расширь существующую, а не копируй.

```ts
test('перевод от человека по телефону приходом не считается', () => {
  // банк присылает на него group=INCOME, хотя это перевод: подгруппа различает
  const [op] = toOperations([
    baseOperation({ group: 'INCOME', subgroup: { id: 'C10', name: 'Пополнение по номеру телефона' } }),
  ])
  expect(op?.kind).toBe('transfer_person')
})

test('перевод между своими счетами приходом не считается', () => {
  const [op] = toOperations([
    baseOperation({ group: 'INCOME', subgroup: { id: 'C5', name: 'Пополнения' } }),
  ])
  expect(op?.kind).toBe('transfer_self')
})

test('внесение наличных приходом не считается', () => {
  const [op] = toOperations([
    baseOperation({ group: 'INCOME', subgroup: { id: 'C3', name: 'Пополнения' } }),
  ])
  expect(op?.kind).toBe('cash')
})

test('перевод от человека другим каналом тоже не приход', () => {
  const [op] = toOperations([
    baseOperation({ group: 'INCOME', subgroup: { id: 'C4', name: 'Пополнения' } }),
  ])
  expect(op?.kind).toBe('transfer_person')
})

test('незнакомая подгруппа оставляет вид по группе', () => {
  // банк вправе завести новый код в любой момент; терять из-за этого операцию
  // нельзя, и «доход» тут — честная деградация, а не догадка
  const [op] = toOperations([
    baseOperation({ group: 'INCOME', subgroup: { id: 'C2', name: 'Пополнения' } }),
  ])
  expect(op?.kind).toBe('income')
})

test('операция без подгруппы разбирается по группе', () => {
  const [op] = toOperations([baseOperation({ group: 'INCOME' })])
  expect(op?.kind).toBe('income')
})

test('подгруппа не перекрывает группу там, где группа права', () => {
  // подгруппы оплат и снятий в таблицу не входят намеренно: заводить для них
  // записи значило бы завести второй источник истины о том же самом
  const pay = toOperations([baseOperation({ group: 'PAY', subgroup: { id: 'A1', name: '' } })])
  expect(pay[0]?.kind).toBe('purchase')
  const cash = toOperations([baseOperation({ group: 'CASH', subgroup: { id: 'B1', name: 'Снятия наличных' } })])
  expect(cash[0]?.kind).toBe('cash')
})

test('подгруппа из прототипа видом не становится', () => {
  const [op] = toOperations([
    baseOperation({ group: 'INCOME', subgroup: { id: 'toString', name: '' } }),
  ])
  expect(op?.kind).toBe('income')
})

test('незнакомая группа с известной подгруппой остаётся нераспознанной', () => {
  // подгруппа уточняет группу, а не заменяет её: про операцию из группы,
  // которой мы не знаем, мы не знаем ничего
  const [op] = toOperations([
    baseOperation({ group: 'НОВОЕ', subgroup: { id: 'C5', name: 'Пополнения' } }),
  ])
  expect(op?.kind).toBe('unknown')
})
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd collector && pnpm vitest run src/plugins/tbank/map.test.ts`
Expected: FAIL у четырёх тестов с подгруппами `C10`, `C5`, `C3`, `C4` — сейчас все они дают `income`. Остальные новые тесты должны пройти сразу: они закрепляют поведение, которое уже верно, и падать начнут только на мутациях.

- [ ] **Step 3: Написать таблицу и уточнение**

В `collector/src/plugins/tbank/map.ts`, сразу после `BANK_GROUP_TO_KIND`:

```ts
// Группа INCOME огрубляет: под ней у банка лежат и переводы от людей, и
// движение собственных денег владельца. Различает их подгруппа, и здесь она
// перекрывает решение по группе.
//
// Ключ — идентификатор, а не имя: имя «Пополнения» банк использует
// одновременно для C2, C3, C4 и C5, то есть не различает ничего. (В таблице
// категорий рядом ключом взято имя — там оно уникально и читается лучше.
// Правило одно: брать то поле, которое различает.)
//
// Отвергнутый признак: isInner. Он выглядел подходящим — у «Между своими
// счетами» он true, — но замер показал девять операций TRANSFER с isInner=true.
// Это переводы с людьми внутри Т-Банка, то есть поле означает «внутри банка».
//
// Подгруппы оплат (A1), снятий (B1), переводов (F1) и внутренних операций (G1)
// сюда намеренно не входят: там группа отвечает верно, и вторая запись о том же
// самом стала бы вторым источником истины.
// export — ради инварианта, который закрепляет тест в Task 2: ни одна строка
// не ведёт обратно в income, и на этом стоит счётчик при сборе
export const BANK_SUBGROUP_TO_KIND: Record<string, string> = {
  C10: 'transfer_person', // пополнение по номеру телефона — перевод от человека
  C4: 'transfer_person', // пополнение с карты другого человека
  C5: 'transfer_self', // между своими счетами
  C3: 'cash', // внесение наличных через банкомат
}
```

Заменить `resolveKind` на:

```ts
// В отличие от суммы и валюты, незнакомая группа — не повод останавливаться:
// банк вправе завести новое значение в любой момент, и терять из-за этого
// операцию нельзя. unknown из статистики не исключается, поэтому такая операция
// остаётся видимой, а расхождение словарей заметно по счётчику в выводе сбора
function resolveKind(item: Record<string, unknown>): string {
  const group = getStr(item, 'group')
  if (group === undefined) return 'unknown'
  // проверка на собственное свойство обязательна: справочник — обычный объект,
  // и группа вроде "toString" достала бы из прототипа функцию вместо вида
  if (!Object.hasOwn(BANK_GROUP_TO_KIND, group)) return 'unknown'
  // подгруппа уточняет группу, а не заменяет её: до сюда доходят только
  // операции из групп, которые мы знаем
  return refineBySubgroup(item) ?? BANK_GROUP_TO_KIND[group] ?? 'unknown'
}

function refineBySubgroup(item: Record<string, unknown>): string | undefined {
  const subgroup = getRecord(item, 'subgroup')
  const id = subgroup ? getStr(subgroup, 'id') : undefined
  if (id === undefined || !Object.hasOwn(BANK_SUBGROUP_TO_KIND, id)) return undefined
  return BANK_SUBGROUP_TO_KIND[id]
}
```

`getRecord` и `getStr` в файле уже есть — используй их, не пиши свои.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd collector && pnpm vitest run src/plugins/tbank/map.test.ts`
Expected: PASS, включая все девять новых.

- [ ] **Step 5: Линт и типы**

Run: `cd collector && pnpm lint && pnpm build`
Expected: без замечаний. (`pnpm lint` — это `oxlint --deny-warnings`; `pnpm build` — `tsc --noEmit`, скрипта `typecheck` в проекте нет.)

- [ ] **Step 6: Коммит**

```bash
git add collector/src/plugins/tbank/map.ts collector/src/plugins/tbank/map.test.ts
git commit -m "Подгруппа банка уточняет вид операции: приход от человека — не доход"
```

---

### Task 2: Счётчик приходов, оставшихся доходом

**Files:**
- Modify: `collector/src/runner/report.ts`
- Modify: `collector/src/runner/main.ts:59-60`
- Test: `collector/src/runner/report.test.ts`
- Test: `collector/src/plugins/tbank/map.test.ts` (инвариант таблицы)

Смысл: таблица подгрупп закрывает то, что мы видели в живых данных. Банк заведёт новый код — операция останется доходом, и узнать об этом можно только здесь.

Считать надо операции с видом `income`. Это работает потому, что **ни одна строка таблицы не ведёт в `income`**: значит доходом остаются ровно те, чья подгруппа не нашлась. Инвариант неочевидный и хрупкий — его закрепляет отдельный тест в этой же задаче.

- [ ] **Step 1: Написать падающий тест на инвариант таблицы**

Дописать в `collector/src/plugins/tbank/map.test.ts`:

```ts
test('ни одна подгруппа не ведёт обратно в доход', () => {
  // на этом стоит счётчик в report.ts: он считает оставшиеся income, полагая,
  // что доходом остались ровно нераспознанные подгруппы. Появись здесь
  // отображение в income (например, когда найдём код зарплаты) — счётчик
  // начнёт врать, и чинить надо будет его, а не этот тест
  expect(Object.values(BANK_SUBGROUP_TO_KIND)).not.toContain('income')
})
```

`BANK_SUBGROUP_TO_KIND` экспортирована ещё в Task 1 — просто дополни импорт в начале файла, не заводи второй.

- [ ] **Step 2: Написать падающие тесты на счётчик**

Дописать в `collector/src/runner/report.test.ts`. Там уже есть сборка операции `operation(overrides)` и перехват консоли `captureLog()` — используй их, не заводи вторые. Имя `reportUnrefinedIncome` добавь в существующий импорт из `./report`.

```ts
test('счётчик называет приходы, оставшиеся доходом', () => {
  const log = captureLog()

  reportUnrefinedIncome('acc-app', [
    operation({ external_id: 'op-1', kind: 'income' }),
    operation({ external_id: 'op-2', kind: 'income' }),
    operation({ external_id: 'op-3', kind: 'transfer_person' }),
    operation({ external_id: 'op-4' }),
  ])

  expect(log.lines()).toEqual([
    'счёт acc-app: приход не разобран у 2 — банк прислал незнакомую подгруппу',
  ])
})

test('счётчик молчит, когда все приходы разобраны', () => {
  // молчание — нормальное состояние: доходом остаются только те, чью подгруппу
  // мы не знаем, и в обычный день таких нет
  const log = captureLog()

  reportUnrefinedIncome('acc-app', [
    operation({ external_id: 'op-1', kind: 'transfer_person' }),
    operation({ external_id: 'op-2', kind: 'cash' }),
  ])

  expect(log.lines()).toEqual([])
})

test('в выводе счётчика нет сумм и описаний', () => {
  const log = captureLog()

  reportUnrefinedIncome('acc-app', [
    operation({
      external_id: 'op-1',
      kind: 'income',
      amount: '9999.99',
      description: 'Зарплата за август',
    }),
  ])

  expect(log.lines().join(' ')).not.toContain('9999')
  expect(log.lines().join(' ')).not.toContain('Зарплата')
})
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `cd collector && pnpm vitest run src/runner/report.test.ts src/plugins/tbank/map.test.ts`
Expected: FAIL — `reportUnrefinedIncome` не существует, `BANK_SUBGROUP_TO_KIND` не экспортирован.

- [ ] **Step 4: Написать счётчик**

В `collector/src/runner/report.ts`, после `reportMissingHints`:

```ts
// Таблица подгрупп закрывает то, что видели в живых данных владельца. Банк
// заведёт новый код — операция останется доходом, и узнать об этом можно только
// здесь: тесты сверяются с нашей таблицей, а не с тем, что банк присылает
// сегодня.
//
// Считаем оставшиеся income, а не «незнакомые подгруппы»: ни одна строка
// таблицы не ведёт в income (это закреплено тестом в map.test.ts), поэтому
// доходом остаются ровно нераспознанные. Считать «все незнакомые подгруппы»
// было бы неверно: подгруппы оплат и снятий в таблицу не входят намеренно, и
// счётчик показывал бы сотню при нулевой проблеме.
export function reportUnrefinedIncome(
  appAccountId: string,
  operations: readonly CollectedOperation[],
): void {
  const count = operations.filter((operation) => operation.kind === 'income').length
  if (count === 0) return
  console.log(`счёт ${appAccountId}: приход не разобран у ${count} — банк прислал незнакомую подгруппу`)
}
```

- [ ] **Step 5: Вызвать при сборе**

В `collector/src/runner/main.ts` сразу после `reportMissingHints(appAccountId, operations)` (строка 60):

```ts
    reportUnrefinedIncome(appAccountId, operations)
```

И дополнить импорт на строке 7 — добавить имя в существующий, а не заводить второй:

```ts
import { reportMissingHints, reportUnknownKinds, reportUnrefinedIncome } from './report'
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `cd collector && pnpm vitest run`
Expected: PASS, весь набор коллектора (было 157, станет 170).

- [ ] **Step 7: Линт и типы**

Run: `cd collector && pnpm lint && pnpm build`
Expected: без замечаний.

- [ ] **Step 8: Коммит**

```bash
git add collector/src/runner/report.ts collector/src/runner/main.ts collector/src/runner/report.test.ts collector/src/plugins/tbank/map.test.ts
git commit -m "Счётчик приходов, оставшихся доходом после уточнения подгруппой"
```

---

### Task 3: Описать в README

**Files:**
- Modify: `README.md` (абзац «Виды операций»)

- [ ] **Step 1: Дополнить абзац**

В `README.md` найти абзац, начинающийся «**Виды операций.** Не всякое движение денег — трата», и дописать в его конец:

```markdown
  Не всякий приход — доход: банк присылает одну и ту же пометку и на перевод от
  человека, и на перекладывание денег между вашими же счетами, и на внесение
  наличных. Мы их различаем и доходом не называем. Про деньги от человека
  честно сказать только это — «пришли от человека»: возврат долга, подарок и
  оплата работы выглядят одинаково, и выбирать за вас мы не будем.
```

- [ ] **Step 2: Коммит**

```bash
git add README.md
git commit -m "README: не всякий приход — доход"
```

---

## Финальная проверка

- [ ] **Прогнать коллектор целиком**

```bash
cd collector && pnpm lint && pnpm build && pnpm vitest run
```

- [ ] **Убедиться, что бэкенд и фронт не задеты**

```bash
git diff --stat 07fc7f2..HEAD -- backend frontend
```

Ожидается: пусто. Эта работа целиком в коллекторе.

- [ ] **Живой прогон**

Собрать заново и подтвердить импорт. Ожидается на данных владельца: приходов с видом `income` останется **один** (возврат `C2`, он же и попадёт в счётчик), «Между своими счетами» уйдут в `transfer_self`, «Внесение наличных» — в `cash`, переводы от людей — в `transfer_person`. До работы доходом числились 44 операции.
