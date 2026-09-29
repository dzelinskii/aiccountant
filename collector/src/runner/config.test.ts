import { expect, test } from 'vitest'
import { appConnection, loadConfig } from './config'

const TOKEN = 'secret-token'

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { AICCOUNTANT_TOKEN: TOKEN, AICCOUNTANT_WORKSPACE: 'ws-1', ...extra }
}

test('без необязательных переменных берутся значения по умолчанию', () => {
  const config = loadConfig(env())

  expect(config).toEqual({
    apiBaseUrl: 'http://localhost:8000',
    apiToken: TOKEN,
    workspaceId: 'ws-1',
    days: 30,
    bank: 'tbank',
  })
})

test('AICCOUNTANT_TOKEN обязателен', () => {
  expect(() => loadConfig({ AICCOUNTANT_WORKSPACE: 'ws-1' })).toThrow(/AICCOUNTANT_TOKEN/)
})

test('AICCOUNTANT_WORKSPACE обязателен', () => {
  expect(() => loadConfig({ AICCOUNTANT_TOKEN: TOKEN })).toThrow(/AICCOUNTANT_WORKSPACE/)
})

test('пустая строка в обязательной переменной — это не значение', () => {
  expect(() => loadConfig(env({ AICCOUNTANT_WORKSPACE: '' }))).toThrow(/AICCOUNTANT_WORKSPACE/)
})

test('сообщение об ошибке не содержит значение токена', () => {
  // сообщение видно в консоли и в чужих логах, а токен приложения — секрет
  const broken = env({ AICCOUNTANT_WORKSPACE: '' })

  expect(() => loadConfig(broken)).toThrow()
  try {
    loadConfig(broken)
  } catch (error) {
    expect(String(error)).not.toContain(TOKEN)
  }
})

test('COLLECT_DAYS задаёт глубину сбора', () => {
  expect(loadConfig(env({ COLLECT_DAYS: '7' })).days).toBe(7)
})

test('нечисловой COLLECT_DAYS — ошибка, а не NaN', () => {
  // Number('abc') даёт NaN, из него получилась бы невалидная дата и мусорный
  // запрос к банку вместо понятного отказа
  expect(() => loadConfig(env({ COLLECT_DAYS: 'abc' }))).toThrow(/COLLECT_DAYS/)
})

test('ноль, отрицательное и дробное значение COLLECT_DAYS — ошибка', () => {
  for (const value of ['0', '-5', '1.5']) {
    expect(() => loadConfig(env({ COLLECT_DAYS: value }))).toThrow(/COLLECT_DAYS/)
  }
})

test('AICCOUNTANT_URL меняет адрес приложения', () => {
  expect(loadConfig(env({ AICCOUNTANT_URL: 'https://app.example' })).apiBaseUrl).toBe(
    'https://app.example',
  )
})

test('не-адрес в AICCOUNTANT_URL — ошибка с именем переменной', () => {
  expect(() => loadConfig(env({ AICCOUNTANT_URL: 'localhost:8000' }))).toThrow(/AICCOUNTANT_URL/)
})

test('банк по умолчанию — Т-Банк, чтобы прежние запуски не сломались', () => {
  const config = loadConfig(env())
  expect(config.bank).toBe('tbank')
})

test('незнакомый банк отвергается со списком известных', () => {
  // 'vtb' коллектором не поддержан (в BANK_NAMES его нет) — годится примером
  // неизвестного банка; 'alfa' раньше был таким примером, но теперь поддержан
  expect(() => loadConfig(env({ COLLECT_BANK: 'vtb' }))).toThrow(/vtb/)
})

test('alfa принимается как известный банк', () => {
  expect(loadConfig(env({ COLLECT_BANK: 'alfa' })).bank).toBe('alfa')
})

test('CLI предъявляет приложению API-токен как Bearer: ядру нужно только соединение', () => {
  expect(appConnection(loadConfig(env({ AICCOUNTANT_URL: 'https://app.example' })))).toEqual({
    baseUrl: 'https://app.example',
    workspaceId: 'ws-1',
    authorization: `Bearer ${TOKEN}`,
  })
})
