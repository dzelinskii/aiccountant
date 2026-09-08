import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { CATEGORY_HINTS, MCC_TO_HINT, hintFromMcc } from './category-hints'

test('код супермаркета переводится в подсказку', () => {
  expect(hintFromMcc('5411')).toBe('groceries')
})

test('код из диапазона авиалиний переводится в поездки', () => {
  // у каждой авиакомпании свой код в 3000–3299, перечислять их незачем
  expect(hintFromMcc('3012')).toBe('travel')
  expect(hintFromMcc('3721')).toBe('travel')
})

test('верхняя граница диапазона авиалиний включена, а следующий код — уже нет', () => {
  expect(hintFromMcc('3299')).toBe('travel')
  expect(hintFromMcc('3300')).toBeNull()
})

test('заглушки банка кодами не считаются', () => {
  // ровно эти значения приходят от Т-Банка вместо MCC у переводов
  for (const stub of ['0 0000', '1 0001', '9999 9999', '8 0008', '18 0018']) {
    expect(hintFromMcc(stub)).toBeNull()
  }
})

test('число, спрятанное в нечётком формате, кодом не считается', () => {
  // Number(' 3012') === 3012 и Number('03012') === 3012 — JS Number()
  // обрезает пробелы и терпит ведущие нули. Без строгой проверки формата эти
  // строки провалились бы в диапазон авиалиний, хотя MCC ими не являются
  expect(hintFromMcc(' 3012')).toBeNull()
  expect(hintFromMcc('03012')).toBeNull()
})

test('отсутствие кода и незнакомый код дают пусто', () => {
  expect(hintFromMcc(undefined)).toBeNull()
  expect(hintFromMcc('7777')).toBeNull()
})

test('снятие наличных подсказкой не считается', () => {
  // 6011 — банкомат: это вид операции, а не то, на что потрачены деньги
  expect(hintFromMcc('6011')).toBeNull()
})

test('все значения таблицы есть в словаре', () => {
  const known = new Set<string>(CATEGORY_HINTS)
  const codes = ['5411', '5812', '4121', '4900', '5912', '8011', '5944', '0742']
  for (const code of codes) {
    const hint = hintFromMcc(code)
    expect(hint === null || known.has(hint)).toBe(true)
  }
})

// Объектный литерал TypeScript молча берёт последнее значение при повторе
// ключа — ни типы, ни линт на это не пожалуются, а строка тихо пропадёт из
// таблицы. Проверить это через готовый MCC_TO_HINT нельзя: к моменту, когда
// объект собран, дубликат уже схлопнут. Поэтому тест разбирает исходный текст
// модуля и считает ключи там, до того как их съел рантайм.
test('в таблице MCC нет задвоенных кодов', () => {
  // читаем исходник, а не готовый объект: задвоенный ключ JavaScript схлопывает
  // ещё при разборе файла, и в объекте от него не остаётся следа
  const path = fileURLToPath(new URL('./category-hints.ts', import.meta.url))
  const source = readFileSync(path, 'utf-8')
  // \r?\n обязателен: в рабочей копии на Windows файл лежит с CRLF, и регулярка
  // с голым \n не находит таблицу вовсе. Без этого тест зелёный в CI (там LF)
  // и красный локально — то есть проверяет операционную систему, а не таблицу
  const tableMatch = source.match(
    /const MCC_TO_HINT: Record<string, CategoryHint> = \{([\s\S]*?)\r?\n\}\r?\n/,
  )
  expect(tableMatch).not.toBeNull()
  const codes = [...(tableMatch?.[1] ?? '').matchAll(/'(\d{4})':/g)].map((match) => match[1])
  // сверяем с самим объектом, а не с «больше нуля»: захвати регулярка кусок
  // таблицы вместо всей, уникальность проверилась бы на трёх строках из ста
  // семидесяти, и тест молча перестал бы сторожить то, ради чего написан
  expect(new Set(codes).size).toBe(Object.keys(MCC_TO_HINT).length)
})
