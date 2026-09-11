import { expect, test } from 'vitest'
import { loadConfig } from './config'

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
    accountMap: {},
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
  const broken = env({ AICCOUNTANT_ACCOUNTS: '{сломано', AICCOUNTANT_WORKSPACE: '' })

  expect(() => loadConfig(broken)).toThrow()
  try {
    loadConfig(broken)
  } catch (error) {
    expect(String(error)).not.toContain(TOKEN)
  }
})

test('AICCOUNTANT_ACCOUNTS разбирается в соответствие счетов', () => {
  const config = loadConfig(env({ AICCOUNTANT_ACCOUNTS: '{"bank-1":"app-1","bank-2":"app-2"}' }))

  expect(config.accountMap).toEqual({ 'bank-1': 'app-1', 'bank-2': 'app-2' })
})

test('битый JSON в AICCOUNTANT_ACCOUNTS — понятная ошибка с именем переменной', () => {
  expect(() => loadConfig(env({ AICCOUNTANT_ACCOUNTS: '{"bank-1":' }))).toThrow(/AICCOUNTANT_ACCOUNTS/)
})

test('массив вместо объекта в AICCOUNTANT_ACCOUNTS — ошибка', () => {
  // у массива ключи тоже строки ("0", "1"), молча он превратился бы в мусорное
  // соответствие счетов
  expect(() => loadConfig(env({ AICCOUNTANT_ACCOUNTS: '["bank-1"]' }))).toThrow(/AICCOUNTANT_ACCOUNTS/)
})

test('нестроковое значение в AICCOUNTANT_ACCOUNTS — ошибка, а не приведение типа', () => {
  expect(() => loadConfig(env({ AICCOUNTANT_ACCOUNTS: '{"bank-1":42}' }))).toThrow(/AICCOUNTANT_ACCOUNTS/)
})

test('пустой идентификатор счёта в AICCOUNTANT_ACCOUNTS — ошибка', () => {
  expect(() => loadConfig(env({ AICCOUNTANT_ACCOUNTS: '{"bank-1":""}' }))).toThrow(/AICCOUNTANT_ACCOUNTS/)
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

test('пер-банковский список счетов важнее общего', () => {
  const config = loadConfig(
    env({
      COLLECT_BANK: 'sber',
      AICCOUNTANT_ACCOUNTS: '{"общий":"a"}',
      AICCOUNTANT_ACCOUNTS_SBER: '{"card:1":"b"}',
    }),
  )
  expect(config.accountMap).toEqual({ 'card:1': 'b' })
})
