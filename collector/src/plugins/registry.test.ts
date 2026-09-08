import { expect, test } from 'vitest'
import { BANK_NAMES, pluginFor } from './registry'

test('плагин находится по имени банка', () => {
  const plugin = pluginFor('tbank')
  expect(plugin.name).toBe('tbank')
  expect(typeof plugin.fetchOperations).toBe('function')
})

test('незнакомое имя банка — понятная ошибка со списком известных', () => {
  expect(() => pluginFor('unknown-bank')).toThrowError(/unknown-bank/)
  expect(() => pluginFor('unknown-bank')).toThrowError(/tbank/)
})

test('имя плагина совпадает с ключом реестра', () => {
  for (const name of BANK_NAMES) {
    expect(pluginFor(name).name).toBe(name)
  }
})
