# Коллектор Альфа-Банка — план реализации

Исполнение спеки `docs/superpowers/specs/2026-09-11-alfabank-collector-design.md`
(и разведки `2026-09-11-alfabank-api-recon.md`). Инфраструктура коллектора уже
введена работой по Сбербанку — план описывает **дельту**, а не построение с нуля.

Общие правила исполнения (из CLAUDE.md), обязательны для каждой задачи:

- **Мутационное ревью тестов** — критерий приёмки: после реализации внести
  дефект в код и показать, какой тест на него падает. Зелёный прогон
  доказательством не считается.
- Деньги — только строкой/`Decimal`, `float` запрещён, включая тесты.
- Слова банка живут только в `plugins/alfa/map.ts`.
- Правка поведения — правка справочника в том же изменении (иначе docs-gate).
- Перед «готово» задачи: `pnpm oxlint --deny-warnings`, `pnpm build` (типы),
  `pnpm test` — прогнаны и подтверждены.

Секрет и суммы в вывод/логи/транскрипт не попадают на всех этапах.

## Структура файлов (что появится/изменится)

    collector/src/
      http/allowlist-client.ts      # + вариант Credentials 'headers'
      runner/secret-store.ts        # parseCredentials принимает 'headers'
      plugins/alfa/
        client.ts                   # allowlist 3 адреса, вывод X-XSRF-TOKEN
        login.ts                    # OIDC-вход, добыча GW_SESSION_AO + XSRF-TOKEN
        map.ts                      # словарь Альфы: операции, счета, карты
        index.ts                    # объект BankPlugin
        *.test.ts                   # тесты + фикстуры разведки
      plugins/registry.ts           # + ветка 'alfa'
    collector/scripts/gen-reference.ts   # + collector-alfa.md
    docs/reference/generated/collector-alfa.md   # генерируется
    collector/README.md             # раздел Альфы, честная оговорка про allowlist

## Task 1: Контракт — второй заголовок

**Файлы:** `http/allowlist-client.ts`, `runner/secret-store.ts` (+ тесты обоих).

- В `Credentials` добавить `{ kind: 'headers'; headers: Record<string, string> }`.
- `AllowlistClient.headers()`: для `'headers'` выставить все пары поверх `Accept`.
  `buildUrl`: для `'headers'` в query ничего не класть (проверка origin — как есть).
- `secret-store.parseCredentials`: принимать `'headers'` — валидировать, что
  `headers` это объект и каждое значение непустая строка; иначе `null` (негодная
  запись — «секрета нет», не падение, как у прочих вариантов).

**Приёмка / мутации:**
- Тест: клиент с `'headers'` шлёт все заголовки; убрать один из ключей в коде —
  тест падает.
- Тест: `parseCredentials` отвергает `headers` с пустым значением и с не-строкой;
  ослабить проверку — падает.
- Существующие тесты `'query'`/`'header'` (Т-Банк/Сбер) остаются зелёными.

## Task 2: Отображение операций Альфы (`map.ts`, первая половина)

**Файлы:** `plugins/alfa/map.ts`, `plugins/alfa/map.test.ts`, фикстуры операций.

`toOperations(raw, accountId)` → `CollectedOperation[]`. Вход — `parseLossless`
(числа уже строки). Для каждой операции:

- `external_id` = `id` (строка; отсутствует → роняем сбор, как у Сбера).
- `amount`: из `amount.value` (строкой) и `amount.minorUnits` собрать десятичную
  строку сдвигом разрядов; знак — из `direction` (`EXPENSE`→`-`, `INCOME`→`+`).
  Нулевая сумма — падение (бэкенд не примет), как у Сбера. `float` нигде.
- `currency`: `amount.currency`, `RUR`→`RUB`, верхний регистр; пусто/негодно →
  падение (валюта у операции есть всегда).
- `occurred_at`: из `dateTime` (`ГГГГ-ММ-ДДTчч:мм:сс+03:00`) — дата операции по
  Москве. Не разобралось → падение.
- `description`: `title` (+ `comment`, если есть), обрезка до 1000.
- `kind`: `resolveKind` — база по `direction` (`income`/`purchase`), уточнение
  таблицами `ALFA_*` (Task не вводит self иначе как по явному me2me — см. спеку 7.6).
- `category_hint`: `hintFromMcc(mcc)`; нет `mcc` → `null`.

Словари в `map.ts` (единственное место слов Альфы), с `Object.hasOwn`-защитой от
прототипа: `ALFA_OPERATION_TYPE_TO_KIND`, `ALFA_CATEGORY_TO_KIND`,
`UNMAPPED_ALFA_*` (намеренно непереведённые — в справочник).

**Приёмка / мутации:**
- `RUR`→`RUB`: убрать нормализацию — тест падает.
- Знак из `direction`: поменять ветку — расход становится приходом, тест падает.
- `value/minorUnits`: фикстура с суммой, где потерялась бы точность на `float`
  (например `minorUnits=100`, большое `value`) — тест на точную строку падает
  при любой реализации через `Number`.
- `transfer_self` только по явному me2me: подать `CARD2CARD_TRANSFER` без me2me —
  ждём `transfer_person`; если код ставит `transfer_self`, тест падает.
- Незнакомый `category.id`/`operationType` → `unknown` (не падение).

## Task 3: Отображение счетов и карт Альфы (`map.ts`, вторая половина)

**Файлы:** `plugins/alfa/map.ts`, тесты, фикстуры `/account/` и `/masked-cards`.

- `toAccounts(rawAccounts, rawCards)` → `CollectedAccount[]`:
  - **исключить `GK`** (брокерские) и металлические (по `description`/`type`);
  - `id` = `number`; `name` = `description`; `type` = `type`;
  - `currency` из денежного блока, `RUR`→`RUB`; негодно → `null` (не падение);
  - `balance`: **`total`** (не `amount`) строкой; нет → `null`;
  - `cardMasks`: последние 4 цифры `number` тех карт, у кого `account.number`
    совпал с номером счёта; негодная маска отбрасывается.

**Приёмка / мутации:**
- Кредитка: остаток берётся из `total`, не `amount` — подменить поле, тест на
  собственную позицию падает (фикстура, где `total ≠ amount`).
- `GK` исключён — фикстура с брокерским (в т.ч. мультивалютным одним номером);
  если не исключать, тест на уникальность `id` и на состав списка падает.
- `cardMasks` группируются по `account.number`; сломать сопоставление — падает.

## Task 4: Клиент Альфы и окно входа

**Файлы:** `plugins/alfa/client.ts`, `plugins/alfa/login.ts` (+ тесты).

- `client.ts`: `ALFA_BASE`, пути-константы, `ALFA_ALLOWED` (3 адреса, метод у
  каждого). `createAlfaClient(credentials, {ca,...})`: принимает `'header'`
  (Cookie), достаёт `XSRF-TOKEN` из строки, строит `AllowlistClient` с
  `{kind:'headers', headers:{Cookie, 'X-XSRF-TOKEN'}}`, транспорт
  `httpsTransport(ca)`. Нет `XSRF-TOKEN` в куке — понятная ошибка.
- `login.ts`: `obtainAlfaCookies(prompt)` — открыть `web.alfabank.ru`, ждать
  `/dashboard`, забрать из jar `GW_SESSION_AO` и `XSRF-TOKEN`, собрать строку
  `Cookie`. Пустое значение куки не считать найденным (ловушка Сбера).

**Приёмка / мутации:**
- `createAlfaClient` кладёт `X-XSRF-TOKEN`, равный куке `XSRF-TOKEN`; сломать
  извлечение — тест падает.
- allowlist: запрос на неразрешённый путь/метод отвергается.
- `obtainAlfaCookies`: без одной из двух кук — понятная ошибка, не пустой секрет.

## Task 5: Объект плагина и реестр

**Файлы:** `plugins/alfa/index.ts`, `plugins/registry.ts` (+ тесты).

- `createAlfaPlugin({ca,...})` → `BankPlugin`, `name='alfa'`:
  - `login` → `{kind:'header', name:'Cookie', value: await obtainAlfaCookies}`;
  - `isAlive` → `GET /account/`; `200`→true; `BankHttpError.status===302`→false;
    прочее — пробросить (не выдавать за протухшую сессию);
  - `fetchAccounts` → `/account/` + `/masked-cards`, `toAccounts`;
  - `fetchOperations(cred, accountId, since, until)` → пагинация по `page`,
    `size=100`, тело с `from/to` (`toAlfaDate`, Москва, `ГГГГ-ММ-ДД`) и фильтром
    `accounts:[accountId]`, до короткой страницы; страховка `MAX_PAGES`.
- `registry.ts`: `BANK_NAMES` += `'alfa'`; ветка `createAlfaPlugin`.

**Приёмка / мутации:**
- `isAlive`: подать ответ `302` — false; `500` — проброс (не false). Сломать
  условие статуса — падает.
- Пагинация: короткая страница завершает обход; фикстура из 2 страниц (100 + <100).
- `toAlfaDate`: полночь по Москве не уезжает на прошлые сутки (тест на границе).
- `registry`: `pluginFor('alfa')` возвращает плагин; неизвестное имя — ошибка со
  списком.

## Task 6: Справочник, README, живой прогон

**Файлы:** `scripts/gen-reference.ts`, `docs/reference/generated/collector-alfa.md`,
`collector/README.md`.

- `gen-reference.ts`: `renderAlfa()` из словарей `alfa/map.ts` (виды по
  `operationType`/`category.id`, намеренно непереведённые), четвёртый файл
  `collector-alfa.md`. Генерируется, руками не править; CI сверяет.
- `README.md`: раздел Альфы; **честная оговорка про allowlist** (POST-банк,
  гарантия — сам список из 3 адресов, все читающие); срок жизни сессии короткий,
  повторный вход по ПИН; продление refresh-токеном — будущее.
- **Живой прогон** на настоящем кабинете: сбор по расчётному и кредитному счёту,
  импорт до превью. Итоги (что из «не проверено» подтвердилось) дописать в §12
  спеки — как сделано у Сбера.

**Приёмка:** `pnpm reference` даёт стабильный вывод, CI-сверка зелёная; линт,
типы, тесты — зелёные; живой прогон довёл импорт.

## Порядок и зависимости

1 → 2 → 3 → 4 → 5 → 6. Task 1 не зависит от плагина (общий контракт). Tasks 2–3
(map) не зависят от 4–5 (сеть) — тестируются на фикстурах. Живой прогон (6) —
последним, когда всё зелёное.
