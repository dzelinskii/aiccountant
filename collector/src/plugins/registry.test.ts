import { expect, test } from 'vitest'
import { BANK_NAMES, pluginFor } from './registry'

function refusingLoadCa(): () => Promise<string> {
  return () => Promise.reject(new Error('loadCa не должен вызываться для этого банка'))
}

test('плагин находится по имени банка', async () => {
  const plugin = await pluginFor('tbank', { loadCa: refusingLoadCa() })
  expect(plugin.name).toBe('tbank')
  expect(typeof plugin.fetchOperations).toBe('function')
})

test('незнакомое имя банка — понятная ошибка со списком известных', async () => {
  await expect(pluginFor('unknown-bank', { loadCa: refusingLoadCa() })).rejects.toThrowError(/unknown-bank/)
  await expect(pluginFor('unknown-bank', { loadCa: refusingLoadCa() })).rejects.toThrowError(/tbank/)
})

test('имя из прототипа объекта — та же понятная ошибка, а не значение из Object.prototype', () => {
  // выбор банка идёт через if/else, а не через индексацию объекта по имени,
  // поэтому "toString"/"constructor" просто не совпадают ни с одной веткой —
  // но проверяем явно: имя банка нигде не должно всплыть как ключ доступа
  return Promise.all([
    expect(pluginFor('toString', { loadCa: refusingLoadCa() })).rejects.toThrowError(/toString/),
    expect(pluginFor('constructor', { loadCa: refusingLoadCa() })).rejects.toThrowError(/constructor/),
  ])
})

test('имя плагина совпадает с ключом реестра', async () => {
  for (const name of BANK_NAMES) {
    const plugin = await pluginFor(name, { loadCa: () => Promise.resolve('') })
    expect(plugin.name).toBe(name)
  }
})

test('выбор Т-Банка не трогает корень сертификата вовсе', async () => {
  // Т-Банку чужой УЦ не нужен; требовать его заранее значило бы ронять сбор
  // по Т-Банку при недоступности точки раздачи сертификата Сбербанка
  await expect(pluginFor('tbank', { loadCa: refusingLoadCa() })).resolves.toBeDefined()
})

test('выбор Сбербанка вызывает загрузку корня ровно один раз и использует её результат', async () => {
  let calls = 0
  const loadCa = async (): Promise<string> => {
    calls += 1
    return 'зашитый-корень-для-теста'
  }

  const plugin = await pluginFor('sber', { loadCa })

  expect(calls).toBe(1)
  expect(plugin.name).toBe('sber')
})

test('провал загрузки корня для Сбербанка не проглатывается — результат действительно ожидается', async () => {
  // если бы plugFor не использовал (не await-ил) результат loadCa, отказ
  // загрузки не помешал бы получить плагин
  const failure = new Error('корень недоступен')
  await expect(pluginFor('sber', { loadCa: () => Promise.reject(failure) })).rejects.toBe(failure)
})
