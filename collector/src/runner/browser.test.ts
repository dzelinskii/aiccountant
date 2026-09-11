import { mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

test('COLLECTOR_PROFILE_DIR переносит базу профилей в общий каталог', () => {
  const prev = process.env['COLLECTOR_PROFILE_DIR']
  process.env['COLLECTOR_PROFILE_DIR'] = tmpdir()
  try {
    // профиль уходит в заданный каталог (база + банк), а не под collector/profile
    expect(profileDir('sber')).toBe(join(resolve(tmpdir()), 'sber'))
    expect(profileDir('sber')).not.toBe(fileURLToPath(new URL('../../profile/sber', import.meta.url)))
    // разные банки по-прежнему в разных каталогах
    expect(profileDir('sber')).not.toBe(profileDir('alfa'))
  } finally {
    if (prev === undefined) delete process.env['COLLECTOR_PROFILE_DIR']
    else process.env['COLLECTOR_PROFILE_DIR'] = prev
  }
})

test('относительный COLLECTOR_PROFILE_DIR разворачивается в абсолютный', () => {
  // куки банка не должны зависеть от текущего каталога запуска
  const prev = process.env['COLLECTOR_PROFILE_DIR']
  process.env['COLLECTOR_PROFILE_DIR'] = 'my-profiles'
  try {
    expect(profileDir('alfa')).toBe(join(resolve('my-profiles'), 'alfa'))
  } finally {
    if (prev === undefined) delete process.env['COLLECTOR_PROFILE_DIR']
    else process.env['COLLECTOR_PROFILE_DIR'] = prev
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
