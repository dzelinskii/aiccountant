import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { profileDir } from './browser'
import { readDeclined, rememberDeclined } from './declined'

// Свой временный каталог профилей на файл теста: тесты этого файла пишут на
// диск, и общий каталог профиля столкнул бы их друг с другом при параллельном
// прогоне.
function withTempProfileDir<T>(run: (bank: string) => Promise<T>): Promise<T> {
  const prev = process.env['COLLECTOR_PROFILE_DIR']
  process.env['COLLECTOR_PROFILE_DIR'] = tmpdir()
  const bank = `test-declined-${process.pid}-${Math.random().toString(36).slice(2)}`
  return run(bank).finally(() => {
    if (prev === undefined) delete process.env['COLLECTOR_PROFILE_DIR']
    else process.env['COLLECTOR_PROFILE_DIR'] = prev
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('файла нет — пустое множество, а не ошибка', async () => {
  await withTempProfileDir(async (bank) => {
    expect(await readDeclined(bank)).toEqual(new Set())
  })
})

test('запись и перечитывание возвращают то же множество', async () => {
  await withTempProfileDir(async (bank) => {
    await rememberDeclined(bank, ['aaa', 'bbb'])
    expect(await readDeclined(bank)).toEqual(new Set(['aaa', 'bbb']))
  })
})

test('повторная запись дописывает к уже отклонённым, не затирая их', async () => {
  await withTempProfileDir(async (bank) => {
    await rememberDeclined(bank, ['aaa'])
    await rememberDeclined(bank, ['bbb'])
    expect(await readDeclined(bank)).toEqual(new Set(['aaa', 'bbb']))
  })
})

test('дублирующийся отпечаток не размножается', async () => {
  await withTempProfileDir(async (bank) => {
    await rememberDeclined(bank, ['aaa'])
    await rememberDeclined(bank, ['aaa', 'bbb'])
    expect(await readDeclined(bank)).toEqual(new Set(['aaa', 'bbb']))
  })
})

test('испорченный JSON не роняет сбор — читается как пустое множество, причина печатается строкой', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await withTempProfileDir(async (bank) => {
    await mkdir(profileDir(bank), { recursive: true })
    await writeFile(join(profileDir(bank), 'declined-accounts.json'), '{не json', 'utf8')

    expect(await readDeclined(bank)).toEqual(new Set())
    expect(log).toHaveBeenCalledOnce()
    expect(String(log.mock.calls[0]?.[0])).toContain(bank)
  })
})

test('файл, не являющийся списком строк, тоже читается как пустое множество', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await withTempProfileDir(async (bank) => {
    await mkdir(profileDir(bank), { recursive: true })
    await writeFile(join(profileDir(bank), 'declined-accounts.json'), JSON.stringify({ a: 1 }), 'utf8')

    expect(await readDeclined(bank)).toEqual(new Set())
  })
})
