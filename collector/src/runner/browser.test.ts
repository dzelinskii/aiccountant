import { mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { certificateArgs, forgetProfile, profileDir } from './browser'

// Сам вход, куки и запуск браузера требуют живого Playwright и здесь не
// проверяются: мок вокруг чужой библиотеки доказывал бы только то, что мок
// написан (см. историю удалённого session.test.ts). Проверяем то, что
// решается без браузера: хранение профиля, «забыть» и сборку флагов запуска.

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('пин закрепляется флагом, если свой браузер не задан', () => {
  expect(certificateArgs('AAAA', undefined)).toEqual(['--ignore-certificate-errors-spki-list=AAAA'])
})

test('без пина флагов нет', () => {
  expect(certificateArgs(undefined, undefined)).toEqual([])
})

test('свой браузер несёт доверие сам — закрепление не нужно, даже если пин задан', () => {
  expect(certificateArgs('AAAA', '/usr/bin/browser')).toEqual([])
})

test('без пина и без своего браузера флагов нет', () => {
  expect(certificateArgs(undefined, '/usr/bin/browser')).toEqual([])
})

test('у каждого банка свой каталог профиля', () => {
  expect(profileDir('tbank')).not.toBe(profileDir('sber'))
})

test('путь профиля считается от файла модуля, а не от текущего каталога', async () => {
  // Профиль обязан лежать в collector/profile: ровно этот путь закрыт
  // .gitignore. Считайся он от cwd — запуск из корня репозитория завёл бы
  // куки банка в каталоге, который git видит
  expect(profileDir('tbank')).toBe(fileURLToPath(new URL('../../profile/tbank', import.meta.url)))

  const before = process.cwd()
  process.chdir(tmpdir())
  try {
    vi.resetModules()
    const fromOtherCwd = (await import('./browser')).profileDir('tbank')
    expect(fromOtherCwd).toBe(profileDir('tbank'))
  } finally {
    process.chdir(before)
  }
})

test('«забыть» удаляет каталог профиля вместе с содержимым', async () => {
  const dir = profileDir(`test-forget-${process.pid}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Cookies'), 'здесь лежала бы кука банка')

  await forgetProfile(`test-forget-${process.pid}`)

  expect(await exists(dir)).toBe(false)
})

test('«забыть» на несуществующем профиле не падает', async () => {
  // забыть доступ должно получаться и до первого входа, и дважды подряд
  await expect(forgetProfile(`test-forget-нет-${process.pid}`)).resolves.toBeUndefined()
})
