import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import type { FetchImpl } from '../http/allowlist-client'
import { ROOT_SHA256, ROOT_SPKI_SHA256, certificateFingerprint, loadTrustAnchor, verifyCertificate } from './trust-anchor'

function realPem(): string {
  return readFileSync(fileURLToPath(new URL('../../tests/fixtures/russian_trusted_root_ca.pem', import.meta.url)), 'utf-8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function tempCachePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-trust-anchor-'))
  return join(dir, 'russian_trusted_root_ca.pem')
}

test('настоящий корень совпадает с зашитым отпечатком', () => {
  expect(certificateFingerprint(realPem())).toBe(ROOT_SHA256)
  expect(() => verifyCertificate(realPem())).not.toThrow()
})

test('подменённый сертификат отвергается, а не используется', () => {
  const tampered = realPem().replace(/^([A-Za-z0-9+/]{20})/m, 'AAAAAAAAAAAAAAAAAAAA')
  expect(() => verifyCertificate(tampered)).toThrowError(/отпечат/i)
})

test('не-сертификат отвергается понятной ошибкой', () => {
  expect(() => verifyCertificate('это не сертификат')).toThrowError(/сертификат/i)
})

test('отпечаток открытого ключа для закрепления в браузере зафиксирован', () => {
  expect(ROOT_SPKI_SHA256).toBe('ArgiDAcHKNt3HZrFnlRSHE7drSGng7smz98ZwdsPrjc=')
})

function okResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

test('загрузка: годный кеш отдаётся без обращения к сети', async () => {
  const cachePath = await tempCachePath()
  await writeFile(cachePath, realPem(), 'utf-8')
  let calls = 0
  const fetchImpl: FetchImpl = async () => {
    calls += 1
    throw new Error('сеть не должна вызываться при годном кеше')
  }

  await expect(loadTrustAnchor(cachePath, fetchImpl)).resolves.toBe(realPem())
  expect(calls).toBe(0)
})

test('загрузка: испорченный кеш — падение, а не тихая перекачка поверх', async () => {
  const cachePath = await tempCachePath()
  const tampered = realPem().replace(/^([A-Za-z0-9+/]{20})/m, 'AAAAAAAAAAAAAAAAAAAA')
  await writeFile(cachePath, tampered, 'utf-8')
  let calls = 0
  const fetchImpl: FetchImpl = async () => {
    calls += 1
    throw new Error('испорченный кеш не должен приводить к скачиванию')
  }

  await expect(loadTrustAnchor(cachePath, fetchImpl)).rejects.toThrowError(/отпечат/i)
  expect(calls).toBe(0)
})

test('загрузка: нет кеша и нет сети — понятная ошибка, а не пустая строка', async () => {
  const cachePath = await tempCachePath()
  const fetchImpl: FetchImpl = async () => {
    throw new TypeError('fetch failed')
  }

  await expect(loadTrustAnchor(cachePath, fetchImpl)).rejects.toThrowError(/gu-st\.ru/)
  expect(await exists(cachePath)).toBe(false)
})

test('загрузка: банк ответил не 200 — ошибка со статусом, файл не создаётся', async () => {
  const cachePath = await tempCachePath()
  const fetchImpl: FetchImpl = async () => new Response('not found', { status: 404 })

  await expect(loadTrustAnchor(cachePath, fetchImpl)).rejects.toThrowError(/404/)
  expect(await exists(cachePath)).toBe(false)
})

test('загрузка: скачанный файл не прошёл проверку — не сохраняется в кеш', async () => {
  const cachePath = await tempCachePath()
  const tampered = realPem().replace(/^([A-Za-z0-9+/]{20})/m, 'AAAAAAAAAAAAAAAAAAAA')
  const fetchImpl: FetchImpl = async () => okResponse(tampered)

  await expect(loadTrustAnchor(cachePath, fetchImpl)).rejects.toThrowError(/отпечат/i)
  expect(await exists(cachePath)).toBe(false)
})

test('загрузка: успешное скачивание сохраняется в кеш и возвращается как есть', async () => {
  const cachePath = await tempCachePath()
  const fetchImpl: FetchImpl = async () => okResponse(realPem())

  await expect(loadTrustAnchor(cachePath, fetchImpl)).resolves.toBe(realPem())
  expect(await readFile(cachePath, 'utf-8')).toBe(realPem())
})
