import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { profileDir } from './browser'

function declinedFile(bank: string): string {
  return join(profileDir(bank), 'declined-accounts.json')
}

/**
 * Отпечатки счетов банка, про которые человек уже сказал «не вести». Живёт в
 * профиле банка, а не в приложении: это удобство человека на его машине, а не
 * факт предметной области. Побочно из этого следует, что `pnpm forget`
 * стирает и эту память вместе с профилем — и это правильно: доступ заводится
 * заново, и разговор начинается заново.
 *
 * Файла нет — пустое множество, а не ошибка: до первого отказа его и не
 * бывает. Испорченный файл сбор не роняет по той же причине, что и негодная
 * запись в secret-store: это файл, который пишет сам коллектор, и падать
 * здесь значило бы останавливать весь сбор из-за памяти об одном лишь
 * удобстве — читаем как пустое множество, а причину печатаем строкой.
 */
export async function readDeclined(bank: string): Promise<Set<string>> {
  const raw = await readFile(declinedFile(bank), 'utf8').catch(() => null)
  if (raw === null) return new Set()
  const parsed = parseDeclined(raw)
  if (parsed === null) {
    console.log(`Память об отклонённых счетах банка ${bank} повреждена, начинаем заново`)
    return new Set()
  }
  return parsed
}

function parseDeclined(raw: string): Set<string> | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return new Set(value)
    }
    return null
  } catch {
    return null
  }
}

/** Дописывает новые отпечатки к уже отклонённым — не затирая прежние. */
export async function rememberDeclined(bank: string, fingerprints: readonly string[]): Promise<void> {
  const merged = new Set([...(await readDeclined(bank)), ...fingerprints])
  await mkdir(profileDir(bank), { recursive: true })
  await writeFile(declinedFile(bank), JSON.stringify([...merged]), 'utf8')
}
