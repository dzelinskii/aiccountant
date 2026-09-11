/**
 * Генератор справочных фактов коллектора: словари перевода банковских слов.
 *
 * Вывод обязан быть детерминированным — сверка в CI сравнивает его с
 * закоммиченным, и любая нестабильность превратит её в шум, который научатся
 * игнорировать.
 *
 * Запуск: cd collector && pnpm reference
 *
 * Скрипт назван не `docs` намеренно: в pnpm есть встроенная команда `pnpm docs
 * <пакет>` (открыть документацию npm-пакета), и она перекрыла бы одноимённый
 * скрипт — `pnpm docs` молча делал бы не то, а в CI падал бы с чужой ошибкой.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATEGORY_HINTS, MCC_RANGES, MCC_TO_HINT } from '../src/core/category-hints'
import {
  BANK_CATEGORY_TO_HINT,
  BANK_GROUP_TO_KIND,
  BANK_SUBGROUP_TO_KIND,
  IGNORED_BANK_CATEGORIES,
} from '../src/plugins/tbank/map'
import { BANK_FORM_TO_KIND, UNMAPPED_BANK_FORMS } from '../src/plugins/sber/map'
import { ALFA_CATEGORY_TO_KIND, ALFA_OPERATION_TYPE_TO_KIND, UNMAPPED_ALFA_KINDS } from '../src/plugins/alfa/map'

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

  return lines.join('\n')
}

function renderSber(): string {
  const lines = [
    WARNING,
    '',
    '# Коллектор: перевод словарей Сбербанка',
    '',
    'Слова банка не покидают его плагина: здесь они переводятся в общий словарь',
    'приложения. У Сбербанка вид операции несёт одно поле `form`, тогда как у',
    'Т-Банка — группа с уточняющей подгруппой.',
    '',
    ...table('Вид операции банка → вид', BANK_FORM_TO_KIND),
  ]

  // молчание о непереведённых видах читалось бы как полнота таблицы
  lines.push('## Виды, намеренно не переведённые', '')
  for (const form of Object.keys(UNMAPPED_BANK_FORMS).sort()) {
    lines.push(`- \`${form}\` — ${UNMAPPED_BANK_FORMS[form]}`)
  }
  lines.push(
    '',
    'Такая операция получает вид `unknown`: она остаётся видимой, попадает в',
    'статистику, и счётчик в выводе сбора о ней сообщает.',
    '',
  )

  return lines.join('\n')
}

function renderAlfa(): string {
  const lines = [
    WARNING,
    '',
    '# Коллектор: перевод словарей Альфа-Банка',
    '',
    'Слова банка не покидают его плагина: здесь они переводятся в общий словарь',
    'приложения. У Альфы вид операции собирается из направления (income/purchase)',
    'и уточняется по operationType (у переводов) и category.id.',
    '',
    ...table('Вид операции (operationType) → вид', ALFA_OPERATION_TYPE_TO_KIND),
    ...table('Категория банка (category.id) → вид', ALFA_CATEGORY_TO_KIND),
  ]

  lines.push(
    'Таблицы выше намеренно неполны: в них только значения, которые меняют вид',
    'относительно направления (переводы). Категориям вроде зарплаты или',
    'пополнения запись не нужна — по направлению они и так `income`.',
    '',
  )

  // молчание о неуточнённых видах читалось бы как полнота таблицы
  lines.push('## Виды, намеренно не уточнённые в v1', '')
  for (const kind of Object.keys(UNMAPPED_ALFA_KINDS).sort()) {
    lines.push(`- \`${kind}\` — ${UNMAPPED_ALFA_KINDS[kind]}`)
  }
  lines.push(
    '',
    'Операция с незнакомыми operationType и category.id получает вид по',
    'направлению: приход — `income`, расход — `purchase` (не `unknown`, в отличие',
    'от Сбера, — у Альфы направление известно всегда). Поэтому счётчик `unknown`',
    'в выводе сбора для Альфы всегда нулевой; непонятое видно двумя другими',
    'счётчиками — неуточнённый приход и трата без подсказки о категории.',
    '',
  )

  return lines.join('\n')
}

// MCC вынесен из документа Т-Банка: коды торговых точек приходят от обоих
// банков и живут в общем модуле, поэтому место им в общем документе, а не в
// файле одного из плагинов
function renderMcc(): string {
  const lines = [
    WARNING,
    '',
    '# Коллектор: коды торговых точек (MCC)',
    '',
    'Таблица общая для всех банков — MCC не банковское понятие. Подсказок о',
    'категории — ' + String(CATEGORY_HINTS.length) + '.',
    '',
    '## MCC → подсказка',
    '',
  ]
  const mcc = byHint(MCC_TO_HINT)
  for (const hint of Object.keys(mcc).sort()) {
    lines.push(`- \`${hint}\`: ${mcc[hint]?.join(', ')}`)
  }
  lines.push('')

  // без диапазонов таблица кодов выглядит полной, хотя ею не является
  lines.push('## MCC: диапазоны', '')
  for (const range of MCC_RANGES) {
    lines.push(`- \`${range.from}\`–\`${range.to}\` → \`${range.hint}\``)
  }
  lines.push('')

  return lines.join('\n')
}

const DIR = fileURLToPath(new URL('../../docs/reference/generated/', import.meta.url))
mkdirSync(DIR, { recursive: true })

for (const [name, body] of [
  ['collector-tbank.md', render()],
  ['collector-sber.md', renderSber()],
  ['collector-alfa.md', renderAlfa()],
  ['collector-mcc.md', renderMcc()],
] as const) {
  writeFileSync(join(DIR, name), body, { encoding: 'utf-8' })
  console.log('записан', name)
}
