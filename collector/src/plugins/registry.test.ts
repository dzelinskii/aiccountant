import { expect, test } from 'vitest'
import { pluginFor } from './registry'

test('плагин находится по имени банка', () => {
  const plugin = pluginFor('tbank')
  expect(plugin.name).toBe('tbank')
  expect(typeof plugin.fetchOperations).toBe('function')
})

test('незнакомое имя банка — понятная ошибка со списком известных', () => {
  expect(() => pluginFor('unknown-bank')).toThrowError(/unknown-bank/)
  expect(() => pluginFor('unknown-bank')).toThrowError(/tbank/)
})

test('имя из прототипа объекта — та же понятная ошибка, а не функция из Object.prototype', () => {
  // без проверки на собственное свойство PLUGINS['toString'] вернул бы функцию
  // toString, а не бросил ошибку — дальше такое имя ушло бы ключом секрета в
  // хранилище ОС и именем парсера в импорт
  expect(() => pluginFor('toString')).toThrowError(/toString/)
  expect(() => pluginFor('constructor')).toThrowError(/constructor/)
})
