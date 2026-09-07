import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { CATEGORY_HINTS } from '../../core/category-hints'
import { BANK_CATEGORY_TO_HINT, IGNORED_BANK_CATEGORIES } from './map'

function dictionaryNames(): string[] {
  const path = fileURLToPath(new URL('../../../tests/fixtures/tbank-category-list.json', import.meta.url))
  const items = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ name: string }>
  return items.map((item) => item.name)
}

test('справочник банка разобран целиком', () => {
  // фикстура — не образец ответа, а обязательство: забыли строку — красный CI,
  // а не тихо некатегоризованная операция через полгода
  const uncovered = dictionaryNames().filter(
    (name) => !Object.hasOwn(BANK_CATEGORY_TO_HINT, name) && !IGNORED_BANK_CATEGORIES.has(name),
  )
  expect(uncovered).toEqual([])
})

test('ни одно значение не переведено и не игнорируется одновременно', () => {
  const both = Object.keys(BANK_CATEGORY_TO_HINT).filter((name) => IGNORED_BANK_CATEGORIES.has(name))
  expect(both).toEqual([])
})

test('таблица не переводит в подсказки вне словаря', () => {
  const known = new Set<string>(CATEGORY_HINTS)
  const unknown = Object.values(BANK_CATEGORY_TO_HINT).filter((hint) => !known.has(hint))
  expect(unknown).toEqual([])
})

test('в таблицах нет значений, которых у банка нет', () => {
  // устаревшая строка — след переименования у банка, и это повод посмотреть,
  // а не молча носить мёртвый ключ
  const names = new Set(dictionaryNames())
  const stale = [...Object.keys(BANK_CATEGORY_TO_HINT), ...IGNORED_BANK_CATEGORIES].filter(
    (name) => !names.has(name),
  )
  expect(stale).toEqual([])
})

test('справочник в фикстуре не усох', () => {
  // защита от подгонки фикстуры под таблицу вместо обратного
  expect(dictionaryNames().length).toBe(90)
})

test('в таблице BANK_CATEGORY_TO_HINT нет задвоенных имён', () => {
  // объектный литерал при повторе ключа молча берёт последнее значение — ни
  // типы, ни линт не возразят, а строка тихо исчезнет из проверки полноты.
  // Проверяем поэтому не разобранный объект (дубли там уже схлопнуты), а
  // исходный текст файла — как в аналогичном тесте для MCC в core/category-hints.test.ts
  const path = fileURLToPath(new URL('./map.ts', import.meta.url))
  const source = readFileSync(path, 'utf-8')
  const tableMatch = source.match(
    /export const BANK_CATEGORY_TO_HINT: Record<string, CategoryHint> = \{([\s\S]*?)\r?\n\}\r?\n/,
  )
  expect(tableMatch).not.toBeNull()
  const keyPattern = /^\s*(?:'((?:[^'\\]|\\.)*)'|([^\s:'"{}]+))\s*:/gm
  const names = [...(tableMatch?.[1] ?? '').matchAll(keyPattern)].map((match) => match[1] ?? match[2])
  expect(names.length).toBeGreaterThan(0)
  const unique = new Set(names)
  expect(unique.size).toBe(names.length)
})
