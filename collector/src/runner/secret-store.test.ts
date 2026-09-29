import { expect, test } from 'vitest'
import type { Credentials } from '../core/contract'
import { memorySecretStore } from './secret-store'

const HEADER_CREDENTIALS: Credentials = { kind: 'header', name: 'Cookie', value: 'UFS-SESSION=a; UFS-TOKEN=b' }

test('хранилище отдаёт записанное и забывает стёртое', async () => {
  const store = memorySecretStore()
  expect(await store.read('sber')).toBeNull()

  await store.write('sber', HEADER_CREDENTIALS)
  expect(await store.read('sber')).toEqual(HEADER_CREDENTIALS)

  await store.clear('sber')
  expect(await store.read('sber')).toBeNull()
})

test('банки не видят секретов друг друга', async () => {
  const store = memorySecretStore()
  await store.write('sber', HEADER_CREDENTIALS)
  expect(await store.read('tbank')).toBeNull()
})
