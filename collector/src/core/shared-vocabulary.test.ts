import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { CATEGORY_HINTS } from './category-hints'
import { BANK_GROUP_TO_KIND, BANK_SUBGROUP_TO_KIND } from '../plugins/tbank/map'

// Значения питоновского Literal: строки в кавычках между `Literal[` и закрывающей
// скобкой на отдельной строке.
//
// \r? — про CRLF, с которым эти файлы лежат в рабочей копии на Windows. Здесь он
// подстраховка, а не необходимость: перед границей блока стоит [\s\S]*?, и \r
// уходит в саму капчуру. Необходим он там, где закрывающий символ прижат к концу
// строки вплотную, — у сторожа таблицы MCC (core/category-hints.test.ts) голый \n
// делал тест зелёным в CI на Linux и красным локально. Пишем одинаково в обоих
// местах, чтобы разница не выглядела осмысленной.
//
// Не найден блок — падаем с именем файла: без этого регулярка, разъехавшаяся с
// текстом исходника, молча свела бы сверку к сравнению двух пустых списков
function pythonLiteral(file: string, name: string): string[] {
  const path = fileURLToPath(new URL(`../../../backend/app/core/${file}`, import.meta.url))
  const source = readFileSync(path, 'utf-8')
  const block = source.match(new RegExp(`${name} = Literal\\[([\\s\\S]*?)\\r?\\n\\]`))
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
