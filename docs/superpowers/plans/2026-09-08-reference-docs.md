# Справочная документация: механизм и модуль ledger — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Завести справочник текущего состояния системы — рукописные контракты плюс генерируемые факты — и механизм, который не даёт ему разойтись с кодом молча.

**Architecture:** Факты (схема БД, ручки API, словари, границы модулей) существуют в коде ровно в одном месте и генерируются оттуда; CI перегенерирует и падает на расхождении. Руками пишется только то, чего из кода не вывести: чем модуль владеет, инварианты, контракты операций в терминах поведения. Узкие ворота в CI требуют правки документа, когда менялись файлы-носители контракта.

**Tech Stack:** Python 3.12 / SQLAlchemy 2 / FastAPI / pytest; TypeScript / Node / vitest; GitHub Actions.

**Спека:** `docs/superpowers/specs/2026-09-08-reference-docs-design.md`

---

## Структура файлов

| файл | ответственность |
| --- | --- |
| `backend/scripts/gen_reference.py` (создать) | генератор: схема, ручки, словари, границы модулей |
| `backend/tests/test_gen_reference.py` (создать) | генератор детерминирован и покрывает известное |
| `collector/scripts/gen-reference.ts` (создать) | генератор словарей коллектора |
| `collector/src/core/shared-vocabulary.test.ts` (создать) | словари Python и TypeScript совпадают |
| `docs/reference/generated/*.md` (создаются генераторами) | факты, руками не правятся |
| `docs/reference/ledger.md` (создать) | рукописный контракт модуля — образец формы |
| `docs/reference/README.md` (создать) | оглавление и правила ведения |
| `.github/workflows/ci.yml` (править) | сверка генерируемого и узкие ворота |
| `CLAUDE.md` (править) | правило про документ, починка вранья про модули |

**Ключевое требование ко всем генераторам: детерминированность.** Никаких дат,
времени, версий инструментов и словарей в неупорядоченном виде — иначе сверка
в CI будет падать на пустом месте, и первое, чему научатся, — её игнорировать.
Всё сортируется, всё выводится в стабильном порядке.

---

### Task 1: Генератор бэкенда

**Files:**
- Create: `backend/scripts/gen_reference.py`
- Create: `backend/tests/test_gen_reference.py`

Генератор запускается из каталога `backend` и пишет в `../docs/reference/generated/`.
Базу он не трогает: `create_async_engine` соединения не открывает, а у настроек
есть значения по умолчанию (`backend/app/core/settings.py:10`), так что в CI он
работает без сервисов.

- [ ] **Step 1: Написать падающий тест**

Создать `backend/tests/test_gen_reference.py`:

```python
from pathlib import Path

from scripts.gen_reference import render_all


def test_generator_is_deterministic() -> None:
    """Недетерминированный вывод роняет сверку в CI на пустом месте, и первое,
    чему научатся, — её игнорировать."""
    assert render_all() == render_all()


def test_schema_covers_known_tables() -> None:
    schema = render_all()["schema.md"]
    for table in ("transactions", "categories", "accounts", "imports", "api_tokens"):
        assert table in schema


def test_schema_marks_nullable_and_defaults() -> None:
    """Обязательность и умолчания — то, ради чего в схему и смотрят: на них
    держатся обещания вроде «счета до этой миграции продолжают работать»."""
    schema = render_all()["schema.md"]
    # hint у категории nullable — категорий без подсказки большинство
    assert "hint" in schema
    # balance_adjustment не nullable и по умолчанию 0
    assert "balance_adjustment" in schema


def test_api_covers_known_endpoints() -> None:
    api = render_all()["api.md"]
    assert "/api/dashboard" in api
    assert "/api/imports/{import_id}/commit" in api
    assert "POST" in api


def test_api_says_it_is_unversioned() -> None:
    """Чтобы агент не искал /v1 и не выдумал его."""
    assert "не версионирован" in render_all()["api.md"]


def test_vocabularies_cover_operation_kinds() -> None:
    from app.core.operation_kinds import OPERATION_KINDS

    vocab = render_all()["vocabularies.md"]
    for kind in OPERATION_KINDS:
        assert kind in vocab


def test_vocabularies_mark_what_is_out_of_stats() -> None:
    """Какие виды не входят в статистику — самый частый вопрос к этому словарю."""
    vocab = render_all()["vocabularies.md"]
    assert "transfer_self" in vocab
    assert "не входит в статистику" in vocab


def test_vocabularies_cover_all_category_hints() -> None:
    from app.core.category_hints import CATEGORY_HINTS

    vocab = render_all()["vocabularies.md"]
    for hint in CATEGORY_HINTS:
        assert hint in vocab


def test_boundaries_cover_all_contracts() -> None:
    """Контрактов import-linter семь; выпади один из документа — читатель решит,
    что границы там нет."""
    boundaries = render_all()["module-boundaries.md"]
    assert boundaries.count("### ") == 7


def test_generated_files_warn_against_hand_editing() -> None:
    for text in render_all().values():
        assert "не правьте руками" in text
```

Чтобы `from scripts.gen_reference import ...` работал, в `backend/pyproject.toml`
в настройки pytest добавить каталог в путь поиска:

```toml
pythonpath = [".", "scripts"]
```

Секция уже существует (`[tool.pytest.ini_options]`, там же `asyncio_mode`) — дополни её, не заводи вторую. Если `pythonpath` там уже есть, дополни список.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd backend && uv run pytest tests/test_gen_reference.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scripts.gen_reference'`

- [ ] **Step 3: Написать генератор**

Создать `backend/scripts/gen_reference.py`. Устройство: чистая функция
`render_all() -> dict[str, str]` собирает содержимое всех файлов, а `main()`
записывает их на диск. Так генератор проверяется тестом без файловой системы.

```python
"""Генератор справочных фактов: схема, ручки, словари, границы модулей.

Всё это существует в коде ровно в одном месте. Написав то же руками, мы завели
бы второй источник истины — то есть ровно ту болезнь, которую справочник лечит.

Вывод обязан быть детерминированным: сверка в CI сравнивает его с закоммиченным,
и любая нестабильность (даты, порядок словаря) сделает её шумом, который
научатся игнорировать.

Запуск: cd backend && uv run python scripts/gen_reference.py
"""

import tomllib
from pathlib import Path
from typing import Any

from sqlalchemy import Table

from app.core.category_hints import CATEGORY_HINTS, HINT_DEFAULTS
from app.core.db import Base
from app.core.operation_kinds import NON_SPENDING_KINDS, OPERATION_KINDS
from app.ledger.repository import DEFAULT_CATEGORIES

# импорт ради регистрации таблиц в Base.metadata: без него схема выйдет пустой
from app.identity import models as _identity  # noqa: F401
from app.imports import models as _imports  # noqa: F401
from app.ledger import models as _ledger  # noqa: F401
from app.recurring import models as _recurring  # noqa: F401

OUT_DIR = Path(__file__).resolve().parent.parent.parent / "docs" / "reference" / "generated"
PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"

WARNING = (
    "<!-- Этот файл создан генератором, не правьте руками: "
    "правки затрёт следующая перегенерация, а CI её потребует. "
    "Источник — backend/scripts/gen_reference.py -->"
)


def _column_line(table: Table, column: Any) -> str:
    parts = [f"`{column.name}`", f"`{column.type}`"]
    parts.append("обязательна" if not column.nullable else "может быть пустой")
    if column.primary_key:
        parts.append("первичный ключ")
    for fk in sorted(column.foreign_keys, key=lambda f: str(f.target_fullname)):
        parts.append(f"→ `{fk.target_fullname}`")
    if column.server_default is not None:
        parts.append(f"по умолчанию `{column.server_default.arg}`")
    return " · ".join(parts)


def render_schema() -> str:
    lines = [WARNING, "", "# Схема базы данных", ""]
    for table in Base.metadata.sorted_tables:
        lines.append(f"## `{table.name}`")
        lines.append("")
        for column in table.columns:
            lines.append(f"- {_column_line(table, column)}")
        indexes = sorted(table.indexes, key=lambda i: i.name or "")
        if indexes:
            lines.append("")
            lines.append("Индексы:")
            for index in indexes:
                cols = ", ".join(f"`{c.name}`" for c in index.columns)
                kind = "уникальный" if index.unique else "обычный"
                lines.append(f"- `{index.name}` ({kind}): {cols}")
        lines.append("")
    return "\n".join(lines)


def render_api() -> str:
    from app.main import app

    schema = app.openapi()
    lines = [
        WARNING,
        "",
        "# Ручки API",
        "",
        "API **не версионирован**: все пути живут под `/api`, префикса версии нет.",
        "",
    ]
    for path in sorted(schema.get("paths", {})):
        for method in sorted(schema["paths"][path]):
            operation = schema["paths"][path][method]
            summary = operation.get("summary", "")
            lines.append(f"- `{method.upper()} {path}` — {summary}")
    lines.append("")
    return "\n".join(lines)


def render_vocabularies() -> str:
    lines = [WARNING, "", "# Словари", "", "## Виды операций", ""]
    for kind in OPERATION_KINDS:
        note = (
            "не входит в статистику"
            if kind in NON_SPENDING_KINDS
            else "входит в статистику"
        )
        lines.append(f"- `{kind}` — {note}")
    lines.extend(["", "## Категории по умолчанию", ""])
    for name, kind in DEFAULT_CATEGORIES:
        lines.append(f"- {name} ({kind})")
    lines.extend(["", "## Подсказки о категории", ""])
    for hint in CATEGORY_HINTS:
        target = HINT_DEFAULTS[hint]
        where = target.parent if target.sub is None else f"{target.parent} / {target.sub}"
        lines.append(f"- `{hint}` → {where} ({target.kind})")
    lines.append("")
    return "\n".join(lines)


def render_boundaries() -> str:
    with PYPROJECT.open("rb") as handle:
        config = tomllib.load(handle)
    contracts = config["tool"]["importlinter"]["contracts"]
    lines = [
        WARNING,
        "",
        "# Границы модулей",
        "",
        "Проверяются import-linter при каждом прогоне CI; нарушение красит сборку.",
        "",
    ]
    for contract in contracts:
        lines.append(f"### {contract['name']}")
        lines.append("")
        sources = ", ".join(f"`{m}`" for m in contract.get("source_modules", []))
        forbidden = ", ".join(f"`{m}`" for m in contract.get("forbidden_modules", []))
        lines.append(f"- {sources} не импортируют {forbidden}")
        lines.append("")
    return "\n".join(lines)


def render_all() -> dict[str, str]:
    return {
        "schema.md": render_schema(),
        "api.md": render_api(),
        "vocabularies.md": render_vocabularies(),
        "module-boundaries.md": render_boundaries(),
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, text in render_all().items():
        (OUT_DIR / name).write_text(text, encoding="utf-8", newline="\n")
        print(f"записан {name}")


if __name__ == "__main__":
    main()
```

**Про `newline="\n"`:** файлы пишутся с LF всегда. Иначе на Windows они выйдут
с CRLF, в CI на Linux перегенерируются с LF, и сверка будет падать на переводах
строк — ровно та беда, что уже случилась со сторожем таблицы MCC.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd backend && uv run pytest tests/test_gen_reference.py -v`
Expected: PASS, 10 тестов.

Если `test_boundaries_cover_all_contracts` падает с другим числом — значит
контрактов в `pyproject.toml` не семь. Поправь число в тесте на фактическое и
скажи об этом в отчёте, но **не подгоняй генератор**.

- [ ] **Step 5: Сгенерировать файлы**

Run: `cd backend && uv run python scripts/gen_reference.py`
Expected: четыре строки «записан ...». Посмотри получившиеся файлы глазами:
схема должна содержать все таблицы, ручек около сорока.

- [ ] **Step 6: Линт, типы, весь бэкенд**

Run: `cd backend && uv run ruff format . && uv run ruff check . && uv run mypy . && uv run pytest -q`
Expected: без замечаний. До тебя было 371 тест.

Если mypy ругается на `scripts/`, добавь каталог в его настройки в
`backend/pyproject.toml` — генератор должен проверяться типами наравне с кодом,
а не быть исключением.

- [ ] **Step 7: Коммит**

```bash
git add backend/scripts/gen_reference.py backend/tests/test_gen_reference.py backend/pyproject.toml docs/reference/generated
git commit -m "Генератор справочных фактов бэкенда: схема, ручки, словари, границы"
```

---

### Task 2: Словари Python и TypeScript обязаны совпадать

**Files:**
- Create: `collector/src/core/shared-vocabulary.test.ts`

Это самостоятельная ценность, а не подготовка к генератору. `CATEGORY_HINTS`
продублирован в `backend/app/core/category_hints.py` и
`collector/src/core/category-hints.ts` — это договор между коннектором и
приложением. Разойдись он, приложение ответит 422 на живом сборе, и узнать об
этом можно будет только там. **Сегодня это не проверяет ничто:** когда писали
коннектор, списки сверялись разовым скриптом, и скрипт удалили.

Идиома чтения исходника регуляркой в проекте уже есть — так устроены оба
сторожа задвоенных ключей (`category-hints.test.ts`, `hints.test.ts`),
посмотри на них.

- [ ] **Step 1: Открыть таблицу групп**

`BANK_GROUP_TO_KIND` в `collector/src/plugins/tbank/map.ts` (строка ~185)
объявлена без `export`, а тест и генератор её читают. Добавить `export` к
объявлению и короткий комментарий рядом с уже имеющимися:

```ts
// export — таблицу читают сверка словарей с Python и генератор справочника
```

Соседняя `BANK_SUBGROUP_TO_KIND` уже экспортирована с таким же пояснением —
держись того же вида.

- [ ] **Step 2: Написать тест**

Создать `collector/src/core/shared-vocabulary.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { CATEGORY_HINTS } from './category-hints'
import { BANK_GROUP_TO_KIND, BANK_SUBGROUP_TO_KIND } from '../plugins/tbank/map'

// Значения питоновского Literal: берём строки в кавычках между `Literal[` и `]`.
// \r?\n не нужен — здесь нет привязки к концу строки, но точка не должна
// проглатывать закрывающую скобку, поэтому ленивый квантификатор
function pythonLiteral(file: string, name: string): string[] {
  const path = fileURLToPath(new URL(`../../../backend/app/core/${file}`, import.meta.url))
  const source = readFileSync(path, 'utf-8')
  const block = source.match(new RegExp(`${name} = Literal\\[([\\s\\S]*?)\\n\\]`))
  expect(block, `в ${file} не найден ${name} = Literal[...]`).not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string)
}

test('словарь подсказок совпадает с питоновским', () => {
  // договор между коннектором и приложением: разойдётся — 422 на живом сборе,
  // и заметно это станет только там
  const python = pythonLiteral('category_hints.py', 'CategoryHint')
  expect(python.length).toBeGreaterThan(0)
  expect([...python].sort()).toEqual([...CATEGORY_HINTS].sort())
})

test('виды операций из таблиц банка есть в питоновском словаре', () => {
  // коннектор не объявляет вид типом — он уезжает строкой; единственная
  // проверка, что мы не сочинили несуществующий вид, вот эта
  const python = new Set(pythonLiteral('operation_kinds.py', 'OperationKind'))
  expect(python.size).toBeGreaterThan(0)
  const used = [...Object.values(BANK_GROUP_TO_KIND), ...Object.values(BANK_SUBGROUP_TO_KIND)]
  expect(used.filter((kind) => !python.has(kind))).toEqual([])
})
```

- [ ] **Step 3: Убедиться, что тест ловит расхождение**

Прогони: `cd collector && pnpm vitest run src/core/shared-vocabulary.test.ts`
Expected: PASS, 2 теста.

Затем внеси дефект и убедись, что он ловится, — **откатывай редактором**, не
`git checkout` и не `sed -i`:

1. Убери одну подсказку из `CATEGORY_HINTS` в TypeScript → первый тест падает.
2. Впиши в `BANK_SUBGROUP_TO_KIND` вид `'refund'`, которого в питоновском
   словаре нет → второй тест падает.

Если хоть один дефект не пойман — тест бесполезен, перепиши его и скажи об этом.

- [ ] **Step 4: Весь набор, линт, типы**

Run: `cd collector && pnpm vitest run && pnpm lint && pnpm build`
Expected: PASS. До тебя было 171 тест.

- [ ] **Step 5: Коммит**

```bash
git add collector/src/core/shared-vocabulary.test.ts collector/src/plugins/tbank/map.ts
git commit -m "Словари подсказок и видов операций сверяются между Python и TypeScript"
```

---

### Task 3: Генератор коллектора

**Files:**
- Create: `collector/scripts/gen-reference.ts`
- Modify: `collector/package.json` (скрипт `docs`)

- [ ] **Step 1: Открыть диапазоны MCC**

`MCC_RANGES` в `collector/src/core/category-hints.ts` (строка ~127) объявлена без
`export`. Без неё документ соврал бы умолчанием: читатель увидит, что кода 3012
в таблице нет, и решит, что он никуда не отображается, — тогда как диапазон
3000–3299 отправляет его в `travel`. Добавить `export` и комментарий:

```ts
// export — диапазоны входят в справочник: без них таблица кодов выглядит
// полной, хотя ею не является
```

- [ ] **Step 2: Написать генератор**

Создать `collector/scripts/gen-reference.ts`:

```ts
/**
 * Генератор справочных фактов коллектора: словари перевода банковских слов.
 *
 * Вывод обязан быть детерминированным — сверка в CI сравнивает его с
 * закоммиченным, и любая нестабильность превратит её в шум.
 *
 * Запуск: cd collector && pnpm reference
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CATEGORY_HINTS, MCC_RANGES, MCC_TO_HINT } from '../src/core/category-hints'
import {
  BANK_CATEGORY_TO_HINT,
  BANK_GROUP_TO_KIND,
  BANK_SUBGROUP_TO_KIND,
  IGNORED_BANK_CATEGORIES,
} from '../src/plugins/tbank/map'

const WARNING =
  '<!-- Этот файл создан генератором, не правьте руками: ' +
  'правки затрёт следующая перегенерация, а CI её потребует. ' +
  'Источник — collector/scripts/gen-reference.ts -->'

function table(title: string, entries: Record<string, string>): string[] {
  const lines = [`## ${title}`, '']
  for (const key of Object.keys(entries).sort()) {
    lines.push(`- \`${key}\` → \`${entries[key]}\``)
  }
  lines.push('')
  return lines
}

function byHint(entries: Record<string, string>): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const [key, hint] of Object.entries(entries)) {
    ;(grouped[hint] ??= []).push(key)
  }
  for (const list of Object.values(grouped)) list.sort()
  return grouped
}

function render(): string {
  const lines = [
    WARNING,
    '',
    '# Коллектор: перевод словарей Т-Банка',
    '',
    'Слова банка не покидают его плагина: здесь они переводятся в общий словарь',
    'приложения. Подсказок о категории — ' + String(CATEGORY_HINTS.length) + '.',
    '',
    ...table('Группа операции → вид', BANK_GROUP_TO_KIND),
    ...table('Подгруппа → вид (уточняет группу)', BANK_SUBGROUP_TO_KIND),
  ]

  lines.push('## Категории банка → подсказка', '')
  const grouped = byHint(BANK_CATEGORY_TO_HINT)
  for (const hint of Object.keys(grouped).sort()) {
    lines.push(`- \`${hint}\`: ${grouped[hint]?.join(', ')}`)
  }
  lines.push('')

  lines.push('## Категории банка, которые игнорируются намеренно', '')
  for (const name of [...IGNORED_BANK_CATEGORIES].sort()) lines.push(`- ${name}`)
  lines.push('')

  lines.push('## MCC → подсказка', '')
  const mcc = byHint(MCC_TO_HINT)
  for (const hint of Object.keys(mcc).sort()) {
    lines.push(`- \`${hint}\`: ${mcc[hint]?.join(', ')}`)
  }
  lines.push('')

  return lines.join('\n')
}

const OUT = fileURLToPath(new URL('../../docs/reference/generated/collector-tbank.md', import.meta.url))
mkdirSync(fileURLToPath(new URL('../../docs/reference/generated/', import.meta.url)), { recursive: true })
writeFileSync(OUT, render(), { encoding: 'utf-8' })
console.log('записан collector-tbank.md')
```

**Про перевод строк:** `writeFileSync` со строкой, собранной через `join('\n')`,
пишет LF как есть — Node ничего не преобразует. Это то, что нужно: файл должен
быть одинаков на Windows и в CI.

- [ ] **Step 3: Добавить скрипт**

В `collector/package.json`, в `scripts`, рядом с существующими (`test`, `lint`,
`build`, `collect`, `forget`):

```json
    "reference": "tsx scripts/gen-reference.ts"
```

Способ запуска `tsx` посмотри у соседнего `collect` — сделай так же.

- [ ] **Step 4: Сгенерировать и посмотреть**

Run: `cd collector && pnpm reference`
Expected: «записан collector-tbank.md». Открой файл: там должны быть шесть
групп, четыре подгруппы, 79 категорий банка, 11 игнорируемых и 174 кода MCC.

- [ ] **Step 5: Проверить детерминированность**

Run: `cd collector && pnpm reference && git diff --exit-code -- ../docs/reference/generated/collector-tbank.md && pnpm reference && git diff --exit-code -- ../docs/reference/generated/collector-tbank.md`
Expected: обе сверки молчат. Если вторая ругается — вывод недетерминирован,
чини сортировку.

- [ ] **Step 6: Линт, типы, тесты**

Run: `cd collector && pnpm lint && pnpm build && pnpm vitest run`
Expected: без замечаний. Если линт ругается на `scripts/` — не исключай каталог,
а почини код: генератор проверяется наравне с остальным.

- [ ] **Step 7: Коммит**

```bash
git add collector/scripts/gen-reference.ts collector/src/core/category-hints.ts collector/package.json docs/reference/generated/collector-tbank.md
git commit -m "Генератор справочных фактов коллектора: словари перевода Т-Банка"
```

---

### Task 4: CI сверяет генерируемое с кодом

**Files:**
- Modify: `.github/workflows/ci.yml` (работы `backend` и `collector`)

Смысл: перегенерировать и упасть, если результат отличается от закоммиченного.
Ложных срабатываний тут нет по построению — либо код и справочник согласованы,
либо нет.

- [ ] **Step 1: Дописать шаги в работу `backend`**

В `.github/workflows/ci.yml`, в работе `backend`, после `- run: uv run pytest`:

```yaml
      - run: uv run python scripts/gen_reference.py
      - name: Справочник не разошёлся с кодом
        run: |
          # --intent-to-add обязателен: git diff неотслеживаемые файлы не видит,
          # и новый файл от нового генератора прошёл бы сверку молча
          git -C .. add --intent-to-add docs/reference/generated
          if ! git -C .. diff --exit-code -- docs/reference/generated; then
            echo ""
            echo "Генерируемая часть справочника устарела."
            echo "Запустите: cd backend && uv run python scripts/gen_reference.py"
            echo "и закоммитьте изменения в docs/reference/generated."
            exit 1
          fi
```

`git -C ..` нужен потому, что у работы задан `working-directory: backend`, а
пути справочника считаются от корня репозитория.

- [ ] **Step 2: Дописать шаги в работу `collector`**

В той же работе `collector`, после `- run: pnpm build`:

```yaml
      - run: pnpm reference
      - name: Справочник не разошёлся с кодом
        run: |
          # --intent-to-add обязателен: git diff неотслеживаемые файлы не видит,
          # и новый файл от нового генератора прошёл бы сверку молча
          git -C .. add --intent-to-add docs/reference/generated
          if ! git -C .. diff --exit-code -- docs/reference/generated; then
            echo ""
            echo "Генерируемая часть справочника устарела."
            echo "Запустите: cd collector && pnpm reference"
            echo "и закоммитьте изменения в docs/reference/generated."
            exit 1
          fi
```

- [ ] **Step 3: Проверить локально, что сверка ловит расхождение**

Внеси временный дефект — например, добавь в `BANK_SUBGROUP_TO_KIND` строку
`C9: 'cash'` — и прогони:

Run: `cd collector && pnpm reference && git -C .. diff --stat -- docs/reference/generated`
Expected: диф не пуст, то есть сверка в CI на таком состоянии упала бы.

**Верни правку редактором**, перегенерируй и убедись, что диф пуст.

Так же проверь бэкенд: добавь временную колонку в любую модель, перегенерируй,
убедись, что схема изменилась, верни редактором.

- [ ] **Step 4: Коммит**

```bash
git add .github/workflows/ci.yml
git commit -m "CI сверяет генерируемую часть справочника с кодом"
```

---

### Task 5: Узкие ворота на рукописную часть

**Files:**
- Modify: `.github/workflows/ci.yml` (новая работа `docs-gate`)

Ворота краснеют, если диф трогает файлы-носители контракта, но не трогает
`docs/reference/`. Снимаются меткой `docs-not-needed` на PR.

**Ворота узкие намеренно.** Широкие учат себя обходить: если правка
переименования требует правки документа, дешевле всего сделать бессмысленную —
переставить запятую. Ворота зелёные, документ устарел, а в его истории теперь
есть изменения, похожие на поддержание.

- [ ] **Step 1: Добавить работу**

В `.github/workflows/ci.yml`, после работы `docker`, добавить:

```yaml
  docs-gate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    # только на PR: у push в main нет ни базы для сравнения, ни метки-исключения
    if: >-
      github.event_name == 'pull_request' &&
      !contains(github.event.pull_request.labels.*.name, 'docs-not-needed')
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Правка контракта требует правки справочника
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: |
          changed=$(git diff --name-only "$BASE_SHA"...HEAD)
          contract=$(echo "$changed" | grep -E '^(backend/app/[^/]+/service\.py|backend/app/core/|collector/src/core/|collector/src/plugins/[^/]+/map\.ts)' || true)
          touched_docs=$(echo "$changed" | grep -E '^docs/reference/' || true)
          if [ -n "$contract" ] && [ -z "$touched_docs" ]; then
            echo "Изменились файлы, несущие контракт:"
            echo "$contract"
            echo ""
            echo "Справочник в docs/reference/ не тронут."
            echo "Обновите нужный документ — либо поставьте на PR метку"
            echo "docs-not-needed, если правка действительно не меняет поведения."
            exit 1
          fi
          echo "Проверка пройдена."
```

- [ ] **Step 2: Проверить логику команды локально**

Ворота целиком в CI не прогнать, но их условие — обычный shell. Проверь на
своей ветке:

```bash
changed=$(git diff --name-only d00d009...HEAD)
echo "$changed" | grep -E '^(backend/app/[^/]+/service\.py|backend/app/core/|collector/src/core/|collector/src/plugins/[^/]+/map\.ts)' || echo "носителей контракта нет"
echo "$changed" | grep -E '^docs/reference/' || echo "справочник не тронут"
```

Убедись, что выражения отбирают то, что задумано: `service.py` любого модуля,
всё в `app/core/`, всё в `collector/src/core/`, `map.ts` любого плагина. И что
они **не** отбирают тесты, роутеры, модели и вёрстку.

Приведи в отчёте, что именно выбралось на твоей ветке.

- [ ] **Step 3: Коммит**

```bash
git add .github/workflows/ci.yml
git commit -m "Ворота: правка файлов-носителей контракта требует правки справочника"
```

---

### Task 6: Рукописный справочник модуля ledger

**Files:**
- Create: `docs/reference/README.md`
- Create: `docs/reference/ledger.md`

Это образец формы: по нему будут написаны остальные шесть документов во второй
части. **Пишется руками только то, чего не вывести из кода.** Пересказа
реализации и сигнатур быть не должно — это работа кода и комментариев, а
внешний пересказ разойдётся с кодом при первом рефакторинге.

Материал бери из кода (`backend/app/ledger/`) и из спек — но спеки описывают
изменения на свою дату, а документ описывает **состояние сейчас**. Где спека
и код расходятся, прав код; такое расхождение назови в отчёте.

- [ ] **Step 1: Оглавление справочника**

Создать `docs/reference/README.md`:

```markdown
# Справочник: что система есть сейчас

Спеки в `docs/superpowers/specs/` описывают **изменения** — что решили и почему,
на свою дату. Этот справочник описывает **состояние**: как система устроена
сегодня.

Расходятся — прав код, а справочник надо чинить.

## Модули

- [ledger](ledger.md) — счета, категории, операции, остатки

Остальные модули (`imports`, `identity`, `recurring`, `ai`, коллектор, фронтенд)
появятся здесь по мере написания.

## Генерируемое

Файлы в [generated/](generated/) созданы из кода и **руками не правятся**:
схема базы, ручки API, словари, границы модулей. CI перегенерирует их и падает,
если результат отличается от закоммиченного.

Перегенерировать:

    cd backend && uv run python scripts/gen_reference.py
    cd collector && pnpm reference

## Правила ведения

Меняете поведение — правьте документ в том же PR. CI это требует: правка
`*/service.py`, `app/core/*`, `collector/src/core/*` или `plugins/*/map.ts` без
правки `docs/reference/` красит сборку. Если правка и правда не меняет
поведения — метка `docs-not-needed` на PR.

Утверждение, которое можно проверить, должно проверяться: словари и схема
генерируются, границы модулей стережёт import-linter. Руками пишется только то,
что проверить нечем, — и потому его должно быть мало.
```

- [ ] **Step 2: Справочник ledger**

Создать `docs/reference/ledger.md` со следующими разделами. Ниже задан скелет и
**полностью написан один раздел как образец тона и уровня** — остальные пиши
так же: поведение и границы, без внутренностей.

```markdown
# Ledger — счета, категории, операции

Ядро учёта. Владеет счетами, деревом категорий, операциями и правилами
«описание → категория». Не знает ни про банки, ни про то, откуда пришли данные:
разбором выписок и сбором занимается `imports`, аутентификацией — `identity`.

## Инварианты

- Каждая доменная таблица несёт `workspace_id`, и **каждый** запрос фильтрует по
  нему в repository-слое. Утечка между workspace — критический баг.
- Деньги — `Decimal` в коде и `NUMERIC(20,4)` в базе. `float` запрещён везде,
  включая тесты; на клиент суммы уходят строками.
- Знак суммы задаёт направление: расход отрицателен, доход положителен.
  Категория несёт вид (`expense`/`income`), и знак обязан ему соответствовать.

## Виды операций

Список и признак участия в статистике — в [generated/vocabularies.md](generated/vocabularies.md).

Вид определяет коннектор банка и переводит в общий словарь; слова конкретного
банка сюда не попадают. Решение человека (`spending_override`) перекрывает вид
в обе стороны; пусто — судит вид.

## Дерево категорий

Двухуровневое: верхний уровень задаёт человек, второй приносит подсказка банка.
Вложенность в модели не ограничена — третий уровень завести можно, но свёртка
на дашборде поднимает только на один уровень (см. ниже).

У категории есть отметка `hint` — «сюда садится вот эта подсказка банка»,
уникальная в пределах workspace. Отметка живёт на категории, а не в отдельной
таблице соответствий: переименование категории соответствие не рвёт.

## Разрешение подсказки в категорию

Контракт: подсказка банка превращается в категорию этого workspace, заводя
подкатегорию при первой надобности.

Порядок: сначала ищется категория с такой отметкой; не нашлась — берётся
родитель по умолчанию из раскладки и под ним заводится подкатегория. Если имя
подкатегории уже занято категорией, которую человек завёл сам, — она
захватывается и помечается, а не дублируется.

**Не срабатывает молча в четырёх случаях, и все четыре — не ошибка:**
подсказки нет в словаре (разошлись версии коннектора и приложения); знак суммы
не совпал с направлением категории; родителя удалили — воскрешать его не наше
дело; имя занято категорией с другим направлением.

Последнее важно: человек волен завести доходные «Продукты» под расходной
«Едой», и захвати мы её — операция не проведётся, а импорт этот отказ не ловит
и упал бы всей пачкой из-за одной строки.

Заведение подкатегории молчаливое: дерево пополняется только тем, на что человек
действительно тратит. Подсказка **не ставит** `category_confirmed` и **не
создаёт** выученного правила — это машинное решение, а не решение человека.

## Правила «описание → категория»

## Остаток счёта

## Расходы месяца на дашборде

## Чего ledger не знает

## Генерируемое рядом
```

Разделы, оставленные пустыми, напиши сам, держа тот же уровень. Что в них
должно быть по существу:

- **Правила «описание → категория»** — нормализация описания перед сравнением;
  правило, заданное руками, подтверждением не перезаписывается; выученное
  обновляется свободно; отклонение подсказки правила не создаёт; правило
  применяется только при импорте, не при ручном вводе.
- **Остаток счёта** — берётся у того, кто сообщил: есть сообщённое банком
  значение — показывается оно и момент, на который оно верно; нет — сумма
  операций плюс поправка, которую человек задаёт, вводя текущий остаток.
- **Расходы месяца на дашборде** — сворачиваются к категории верхнего уровня
  ровно на один уровень; операции без категории идут отдельной строкой;
  виды, не входящие в статистику, исключены.
- **Чего ledger не знает** — про банки и их словари, про разбор выписок, про
  пользователей и сессии; границы стережёт import-linter.
- **Генерируемое рядом** — ссылки на `generated/schema.md`,
  `generated/vocabularies.md`, `generated/module-boundaries.md`.

- [ ] **Step 3: Сверить документ с кодом**

Каждое утверждение в документе проверь по коду и скажи в отчёте, что сверял.
Особое внимание — четырём случаям несрабатывания подсказки и правилам про
`manual`/`learned`: они списаны со спек, а спеки могли устареть.

Нашёл расхождение спеки с кодом — пиши по коду и назови расхождение в отчёте.

- [ ] **Step 4: Коммит**

```bash
git add docs/reference/README.md docs/reference/ledger.md
git commit -m "Справочник: оглавление и модуль ledger"
```

---

### Task 7: Правило в CLAUDE.md и починка вранья про модули

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Починить список модулей**

В `CLAUDE.md`, в разделе «Архитектурные правила», строка про модули сейчас
перечисляет семь: `identity`, `ledger`, `recurring`, `imports`, `ai`,
`analytics`, `notifications`. **`analytics` и `notifications` — пустые каталоги,
ноль файлов.** Файл читается каждой сессией, и расхождение никто не замечал.

Заменить на перечисление того, что есть, с явной пометкой про задуманное:

```markdown
- Модули backend: `identity`, `ledger`, `recurring`, `imports`, `ai`. Задуманы
  ещё `analytics` и `notifications` — их пока нет. Общение — только через
  сервисные интерфейсы; в таблицы чужого модуля не ходить (контролируется
  import-linter).
```

- [ ] **Step 2: Добавить правило про справочник**

В `CLAUDE.md`, в раздел «Процесс», добавить:

```markdown
- Меняете поведение — правьте `docs/reference/` в том же изменении. CI это
  требует: правка `*/service.py`, `app/core/*`, `collector/src/core/*` или
  `plugins/*/map.ts` без правки справочника красит сборку; снимается меткой
  `docs-not-needed` на PR.
- Генерируемую часть справочника (`docs/reference/generated/`) руками не
  править — она перезаписывается генераторами, и CI сверяет её с кодом.
- Справочник описывает **состояние**, спеки — **изменения**. Расходятся с
  кодом — прав код.
```

- [ ] **Step 3: Добавить пункт в бриф ревьюера**

Третий механизм удержания из спеки (§6) — единственный, который ловит «документ
обновили, но неверно»: ни генерация, ни ворота смыслового сдвига не видят.
Работает он, только пока работаем через субагентов, и это записано в спеке как
честный предел.

В `CLAUDE.md`, в раздел «Процесс», рядом с предыдущим пунктом:

```markdown
- В бриф ревьюера-субагента включать сверку справочника с дифом: описывает ли
  `docs/reference/` то, что код делает теперь, а не то, что делал раньше.
  Генерация и ворота этого не ловят — они видят факт правки, а не её смысл.
```

- [ ] **Step 4: Коммит**

```bash
git add CLAUDE.md
git commit -m "Правила: справочник правится вместе с поведением; модулей пять, а не семь"
```

---

## Финальная проверка

- [ ] **Прогнать всё**

```bash
cd backend && uv run ruff format --check . && uv run ruff check . && uv run mypy . && uv run lint-imports && uv run pytest -q
```

```bash
cd collector && pnpm lint && pnpm build && pnpm vitest run
```

- [ ] **Убедиться, что справочник согласован с кодом**

```bash
cd backend && uv run python scripts/gen_reference.py && cd ../collector && pnpm reference && cd .. && git diff --exit-code -- docs/reference/generated
```

Ожидается: пусто. Если диф не пуст — значит генераторы не запускали после
последней правки кода, и CI бы упал.

- [ ] **Проверить, что ворота сработали бы на этой ветке**

Эта ветка меняет `app/core/*` и `collector/src/core/*` и при этом правит
`docs/reference/` — то есть ворота её пропускают. Убедиться командой из Task 5,
Step 2, и привести вывод.
