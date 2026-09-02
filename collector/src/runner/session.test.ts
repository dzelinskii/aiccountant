import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { forgetSession, PROFILE_DIR } from './session'

// Сам вход и чтение куки требуют живого браузера и здесь не проверяются:
// мок вокруг Playwright доказывал бы только то, что мок написан. Проверяем
// то, что решается без сети, — хранение профиля и «забыть».

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('«забыть» удаляет каталог профиля вместе с содержимым', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-profile-'))
  await writeFile(join(dir, 'Cookies'), 'здесь лежала кука банка')

  await forgetSession(dir)

  expect(await exists(dir)).toBe(false)
})

test('«забыть» на несуществующем профиле не падает', async () => {
  // забыть доступ должно получаться и до первого входа, и дважды подряд
  const dir = join(tmpdir(), `collector-profile-нет-${process.pid}`)

  await expect(forgetSession(dir)).resolves.toBeUndefined()
})

test('путь профиля считается от файла модуля, а не от текущего каталога', async () => {
  // Профиль обязан лежать в collector/profile: ровно этот путь закрыт
  // .gitignore. Считайся он от cwd — запуск из корня репозитория завёл бы
  // куки банка в каталоге, который git видит
  expect(PROFILE_DIR).toBe(fileURLToPath(new URL('../../profile', import.meta.url)))

  const before = process.cwd()
  process.chdir(tmpdir())
  try {
    vi.resetModules()
    const fromOtherCwd = (await import('./session')).PROFILE_DIR
    expect(fromOtherCwd).toBe(PROFILE_DIR)
  } finally {
    process.chdir(before)
  }
})
