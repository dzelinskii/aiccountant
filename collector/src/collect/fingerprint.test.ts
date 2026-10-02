import { expect, test } from 'vitest'
import { accountFingerprint } from './fingerprint'

test('отпечаток одного счёта не меняется между запусками', async () => {
  // на этом держится вся привязка: другой отпечаток — другой счёт, и импорт
  // уехал бы не туда
  expect(await accountFingerprint('alfa', '40817810099910004312')).toBe(
    await accountFingerprint('alfa', '40817810099910004312'),
  )
})

test('одинаковые идентификаторы в разных банках дают разные отпечатки', async () => {
  // у Сбербанка идентификатор — card:<id>, у Альфы — номер счёта; совпадение
  // форматов ничем не запрещено, и банк обязан входить в отпечаток
  expect(await accountFingerprint('sber', '12345')).not.toBe(await accountFingerprint('alfa', '12345'))
})

test('отпечаток — sha256 в нижнем регистре: приложение принимает только такой', async () => {
  expect(await accountFingerprint('tbank', 'acc-1')).toMatch(/^[0-9a-f]{64}$/)
})

test('сырой идентификатор в отпечатке не виден', async () => {
  // ради этого отпечаток и заведён: у Альфы идентификатор — номер счёта,
  // то есть реквизит для перевода
  const number = '40817810099910004312'
  expect(await accountFingerprint('alfa', number)).not.toContain(number)
})

test('отпечаток совпадает с прежним node:crypto: уже сделанные привязки переживают переезд', async () => {
  expect(await accountFingerprint('tbank', 'acc-1')).toBe(
    '451463f49a30812617cce38f3ed28ad994e99b423b94fb678d09ceb52d10daef',
  )
  expect(await accountFingerprint('alfa', '40817810099910004312')).toBe(
    '59122fee16a684b2269500a8cd983a492eed3779fc574a528c101f945bac2014',
  )
})
