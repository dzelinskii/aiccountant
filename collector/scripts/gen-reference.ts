/**
 * Генератор справочных фактов коллектора: словари перевода банковских слов.
 *
 * Вывод обязан быть детерминированным — сверка в CI сравнивает его с
 * закоммиченным, и любая нестабильность превратит её в шум, который научатся
 * игнорировать.
 *
 * Запуск: cd collector && pnpm docs
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

  // без диапазонов таблица кодов выглядит полной, хотя ею не является
  lines.push('## MCC: диапазоны', '')
  for (const range of MCC_RANGES) {
    lines.push(`- \`${range.from}\`–\`${range.to}\` → \`${range.hint}\``)
  }
  lines.push('')

  return lines.join('\n')
}

const OUT = fileURLToPath(new URL('../../docs/reference/generated/collector-tbank.md', import.meta.url))
mkdirSync(fileURLToPath(new URL('../../docs/reference/generated/', import.meta.url)), { recursive: true })
writeFileSync(OUT, render(), { encoding: 'utf-8' })
console.log('записан collector-tbank.md')
