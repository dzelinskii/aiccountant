import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import type { FetchImpl } from '../http/allowlist-client'
import { ROOT_SHA256, ROOT_SPKI_SHA256, certificateFingerprint, loadTrustAnchor, spkiFingerprint, verifyCertificate } from './trust-anchor'

function realPem(): string {
  return readFileSync(fileURLToPath(new URL('../../tests/fixtures/russian_trusted_root_ca.pem', import.meta.url)), 'utf-8')
}

// Второй блок не обязан быть настоящим сертификатом — код отвергает файл по
// одному только числу блоков BEGIN/END, до какой-либо попытки разобрать их
// как X.509. Произвольные байты этого не отличают
function withForeignBlock(pem: string): string {
  const foreignBody = Buffer.from('произвольный второй блок, приписанный к настоящему корню').toString('base64')
  return `${pem}\n-----BEGIN CERTIFICATE-----\n${foreignBody}\n-----END CERTIFICATE-----\n`
}

function countPemBlocks(pem: string): number {
  return pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0
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

test('отпечаток открытого ключа выведен из настоящего сертификата, а не продублирован константой', () => {
  // спека берётся не из самой константы (это была бы тавтология), а
  // независимо считается от фикстуры тем же способом, каким закрепление
  // читает ключ браузер: crypto.createPublicKey + SPKI DER + sha256
  expect(spkiFingerprint(realPem())).toBe(ROOT_SPKI_SHA256)
})

test('PEM с приписанным вторым сертификатом отвергается целиком', () => {
  const withExtra = withForeignBlock(realPem())
  expect(countPemBlocks(withExtra)).toBe(2)
  expect(() => verifyCertificate(withExtra)).toThrowError(/один/)
  expect(() => certificateFingerprint(withExtra)).toThrowError(/один/)
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

  const result = await loadTrustAnchor(cachePath, fetchImpl)
  expect(certificateFingerprint(result)).toBe(ROOT_SHA256)
  expect(calls).toBe(0)
})

test('загрузка: испорченный кеш — падение с указанием файла, а не тихая перекачка поверх', async () => {
  const cachePath = await tempCachePath()
  const tampered = realPem().replace(/^([A-Za-z0-9+/]{20})/m, 'AAAAAAAAAAAAAAAAAAAA')
  await writeFile(cachePath, tampered, 'utf-8')
  let calls = 0
  const fetchImpl: FetchImpl = async () => {
    calls += 1
    throw new Error('испорченный кеш не должен приводить к скачиванию')
  }

  const rejection = loadTrustAnchor(cachePath, fetchImpl)
  await expect(rejection).rejects.toThrowError(/отпечат/i)
  // сообщение должно называть путь к файлу и что с ним делать — иначе
  // человек не поймёт, какой именно файл удалять
  await expect(rejection).rejects.toThrow(cachePath)
  await expect(rejection).rejects.toThrow(/удалите/i)
  expect(calls).toBe(0)
})

test('загрузка: кеш с приписанным вторым сертификатом отвергается, а не уходит в https-транспорт как есть', async () => {
  const cachePath = await tempCachePath()
  await writeFile(cachePath, withForeignBlock(realPem()), 'utf-8')
  const fetchImpl: FetchImpl = async () => {
    throw new Error('испорченный кеш не должен приводить к скачиванию')
  }

  const rejection = loadTrustAnchor(cachePath, fetchImpl)
  await expect(rejection).rejects.toThrow(cachePath)
  await expect(rejection).rejects.toThrow(/один/)
})

test('загрузка: возвращаемая строка не содержит ничего, кроме проверенного сертификата', async () => {
  const cachePath = await tempCachePath()
  // мусор после настоящего блока не образует второй BEGIN/END и потому не
  // ловится счётчиком блоков — единственная защита здесь в том, что наружу
  // уезжают DER-байты проверенного блока, пересобранные заново, а не срез
  // исходного файла
  await writeFile(cachePath, `${realPem()}\nПОСТОРОННИЙ ТЕКСТ ПОСЛЕ СЕРТИФИКАТА\n`, 'utf-8')
  const fetchImpl: FetchImpl = async () => {
    throw new Error('кеш есть, сеть не нужна')
  }

  const result = await loadTrustAnchor(cachePath, fetchImpl)
  expect(countPemBlocks(result)).toBe(1)
  expect(result).not.toContain('ПОСТОРОННИЙ ТЕКСТ')
  expect(certificateFingerprint(result)).toBe(ROOT_SHA256)
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

test('загрузка: PEM с приписанным вторым сертификатом при скачивании отвергается', async () => {
  const cachePath = await tempCachePath()
  const fetchImpl: FetchImpl = async () => okResponse(withForeignBlock(realPem()))

  await expect(loadTrustAnchor(cachePath, fetchImpl)).rejects.toThrowError(/один/)
  expect(await exists(cachePath)).toBe(false)
})

test('загрузка: успешное скачивание сохраняется в кеш и возвращается как канонический PEM', async () => {
  const cachePath = await tempCachePath()
  const fetchImpl: FetchImpl = async () => okResponse(realPem())

  const result = await loadTrustAnchor(cachePath, fetchImpl)
  expect(certificateFingerprint(result)).toBe(ROOT_SHA256)
  expect(countPemBlocks(result)).toBe(1)
  expect(await readFile(cachePath, 'utf-8')).toBe(result)
})
