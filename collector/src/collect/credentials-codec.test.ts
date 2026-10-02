import { expect, test } from 'vitest'
import type { Credentials } from '../core/contract'
import { parseCredentials, serializeCredentials } from './credentials-codec'

const HEADER_CREDENTIALS: Credentials = { kind: 'header', name: 'Cookie', value: 'UFS-SESSION=a; UFS-TOKEN=b' }

test('секрет переживает сериализацию без искажений', () => {
  expect(parseCredentials(serializeCredentials(HEADER_CREDENTIALS))).toEqual(HEADER_CREDENTIALS)
})

test('мусор вместо записи читается как отсутствие секрета, а не падает', () => {
  expect(parseCredentials('не json')).toBeNull()
  expect(parseCredentials('{"kind":"telepathy","name":"x","value":"y"}')).toBeNull()
})

test('секрет из нескольких заголовков переживает сериализацию', () => {
  const headers: Credentials = { kind: 'headers', headers: { Cookie: 'GW_SESSION_AO=s', 'X-XSRF-TOKEN': 'x' } }
  expect(parseCredentials(serializeCredentials(headers))).toEqual(headers)
})

test('негодный headers-секрет читается как отсутствие, а не падает', () => {
  // пустой словарь, пустое значение и нестроковое значение — все три «секрета
  // нет»: клиент с такими заголовками не предъявил бы банку ничего
  expect(parseCredentials('{"kind":"headers","headers":{}}')).toBeNull()
  expect(parseCredentials('{"kind":"headers","headers":{"Cookie":""}}')).toBeNull()
  expect(parseCredentials('{"kind":"headers","headers":{"Cookie":123}}')).toBeNull()
  expect(parseCredentials('{"kind":"headers"}')).toBeNull()
})
