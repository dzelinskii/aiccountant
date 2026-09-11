import { Entry } from '@napi-rs/keyring'
import type { Credentials } from '../core/contract'

const SERVICE = 'aiccountant-collector'

export interface SecretStore {
  read(bank: string): Promise<Credentials | null>
  write(bank: string, credentials: Credentials): Promise<void>
  clear(bank: string): Promise<void>
}

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

/**
 * Секрет живёт в средствах ОС: Credential Manager, Keychain или libsecret.
 * В файлы, переменные окружения и git он не попадает никогда.
 *
 * Расхождение с планом: там `read`/`clear` оборачивались в try/catch,
 * трактующий любое исключение библиотеки как «записи нет». Проверка на этой
 * машине (@napi-rs/keyring 2.0.0) показала, что это не так: отсутствие записи
 * — обычное значение (`getPassword()` → `null`, `deletePassword()` → `false`),
 * а не исключение. Исключение здесь означает настоящий сбой — хранилище
 * заблокировано, недоступно, или в нём конфликтующая запись стороннего
 * приложения (Ambiguous). Глотать такие исключения как «секрета нет» было бы
 * не молчаливой деградацией, а прямым обманом: на `clear` это ровно та ложь
 * («доступ забыт», хотя секрет остался), которую поручено убрать из
 * forget.ts, а на `read` — ложный повторный вход вместо сообщения о том, что
 * хранилище недоступно.
 */
export function osSecretStore(): SecretStore {
  const entry = (bank: string): Entry => new Entry(SERVICE, bank)
  return {
    async read(bank) {
      const raw = entry(bank).getPassword()
      return raw ? parseCredentials(raw) : null
    },
    async write(bank, credentials) {
      entry(bank).setPassword(serializeCredentials(credentials))
    },
    async clear(bank) {
      // возвращает false, если стирать было нечего — «забыть доступ» и так
      // работает до первого входа и повторно, без try/catch
      entry(bank).deletePassword()
    },
  }
}

/** Для тестов и для случая, когда хранить секрет между запусками не нужно. */
export function memorySecretStore(): SecretStore {
  const kept = new Map<string, Credentials>()
  return {
    async read(bank) {
      return kept.get(bank) ?? null
    },
    async write(bank, credentials) {
      kept.set(bank, credentials)
    },
    async clear(bank) {
      kept.delete(bank)
    },
  }
}
