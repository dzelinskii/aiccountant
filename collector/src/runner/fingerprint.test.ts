import { expect, test } from 'vitest'
import { accountFingerprint } from './fingerprint'

test('отпечаток одного счёта не меняется между запусками', () => {
  // на этом держится вся привязка: другой отпечаток — другой счёт, и импорт
  // уехал бы не туда
  expect(accountFingerprint('alfa', '40817810099910004312')).toBe(
    accountFingerprint('alfa', '40817810099910004312'),
  )
})

test('одинаковые идентификаторы в разных банках дают разные отпечатки', () => {
  // у Сбербанка идентификатор — card:<id>, у Альфы — номер счёта; совпадение
  // форматов ничем не запрещено, и банк обязан входить в отпечаток
  expect(accountFingerprint('sber', '12345')).not.toBe(accountFingerprint('alfa', '12345'))
})

test('отпечаток — sha256 в нижнем регистре: приложение принимает только такой', () => {
  expect(accountFingerprint('tbank', 'acc-1')).toMatch(/^[0-9a-f]{64}$/)
})

test('сырой идентификатор в отпечатке не виден', () => {
  // ради этого отпечаток и заведён: у Альфы идентификатор — номер счёта,
  // то есть реквизит для перевода
  const number = '40817810099910004312'
  expect(accountFingerprint('alfa', number)).not.toContain(number)
})
