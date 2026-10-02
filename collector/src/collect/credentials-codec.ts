import type { Credentials } from '../core/contract'

export function serializeCredentials(credentials: Credentials): string {
  return JSON.stringify(credentials)
}

/**
 * Непригодная запись — это не сбой, а «секрета нет»: в хранилище могла остаться
 * запись от прежней версии формата. Падать здесь значило бы требовать от
 * человека руками чистить keychain вместо обычного повторного входа.
 */
export function parseCredentials(raw: string): Credentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record['kind'] === 'headers') {
    const headers = record['headers']
    if (typeof headers !== 'object' || headers === null) return null
    const entries = Object.entries(headers as Record<string, unknown>)
    // пустой словарь или нестроковое/пустое значение — негодная запись, значит
    // «секрета нет»: клиент с такими заголовками не предъявил бы ничего
    if (entries.length === 0) return null
    for (const [, v] of entries) if (typeof v !== 'string' || v === '') return null
    return { kind: 'headers', headers: headers as Record<string, string> }
  }
  const { kind, name, value } = record
  if (kind !== 'query' && kind !== 'header') return null
  if (typeof name !== 'string' || name === '' || typeof value !== 'string' || value === '') return null
  return { kind, name, value }
}
