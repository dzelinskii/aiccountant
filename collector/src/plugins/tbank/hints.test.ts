import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { CATEGORY_HINTS } from '../../core/category-hints'
import { BANK_CATEGORY_TO_HINT, IGNORED_BANK_CATEGORIES, normalizeBankCategoryName } from './map'

function dictionaryNames(): string[] {
  const path = fileURLToPath(new URL('../../../tests/fixtures/tbank-category-list.json', import.meta.url))
  const items = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ name: string }>
  return items.map((item) => item.name)
}

test('справочник банка разобран целиком', () => {
  // фикстура — не образец ответа, а обязательство: забыли строку — красный CI,
  // а не тихо некатегоризованная операция через полгода.
  // Имена из фикстуры ищем так же, как их будет искать боевой код — через
  // нормализацию: в трёх из них у банка стоит неразрывный пробел
  const uncovered = dictionaryNames()
    .map((name) => normalizeBankCategoryName(name))
    .filter((name) => !Object.hasOwn(BANK_CATEGORY_TO_HINT, name) && !IGNORED_BANK_CATEGORIES.has(name))
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
  const names = new Set(dictionaryNames().map((name) => normalizeBankCategoryName(name)))
  const stale = [...Object.keys(BANK_CATEGORY_TO_HINT), ...IGNORED_BANK_CATEGORIES].filter(
    (name) => !names.has(normalizeBankCategoryName(name)),
  )
  expect(stale).toEqual([])
})

test('справочник в фикстуре не усох', () => {
  // защита от подгонки фикстуры под таблицу вместо обратного
  expect(dictionaryNames().length).toBe(90)
})

test('разные написания одного имени дают одну подсказку', () => {
  // Ровно то, ради чего нормализация и заведена: справочник и поток операций —
  // разные ответы банка, и написание пробелов в них может разойтись.
  // Неразрывный пробел записан escape-последовательностью: живым символом его
  // однажды «починят» в обычный, и тест станет пустой проверкой
  const variants = [
    'Ремонт и\u00A0мебель', // неразрывный пробел — так пишет сам банк
    'Ремонт  и мебель', // лишний пробел от руки
    ' Ремонт и мебель ', // пробелы по краям
    'Ремонт и мебель',
  ]
  for (const variant of variants) {
    expect(BANK_CATEGORY_TO_HINT[normalizeBankCategoryName(variant)]).toBe('home')
  }
})

test('составное «й» даёт ту же подсказку, что и предсоставленное', () => {
  // «й» бывает одним кодпоинтом (U+0439) и парой «и» + U+0306: на вид не
  // отличить, побайтово — разные строки. NFC сводит их к одной форме
  const decomposed = 'Онла\u0438\u0306н-супермаркеты'
  expect(decomposed).not.toBe('Онлайн-супермаркеты')
  expect(BANK_CATEGORY_TO_HINT[normalizeBankCategoryName(decomposed)]).toBe('groceries')
})

test('ключи таблиц записаны в каноническом виде', () => {
  // Искать по таблице мы будем нормализованным именем, поэтому ключ, набранный
  // с лишним или неразрывным пробелом, не совпадёт ни с чем — и это не видно
  // глазом. Проверять форму ключей дешевле, чем перестраивать таблицу на лету
  const odd = [...Object.keys(BANK_CATEGORY_TO_HINT), ...IGNORED_BANK_CATEGORIES].filter(
    (name) => normalizeBankCategoryName(name) !== name,
  )
  expect(odd).toEqual([])
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
  const unique = new Set(names)
  expect(unique.size).toBe(names.length)
  // сторож самого сторожа: разъедься регэксп с текстом файла — и проверка выше
  // тихо превратится в проверку пустого списка
  expect(unique.size).toBe(Object.keys(BANK_CATEGORY_TO_HINT).length)
})
