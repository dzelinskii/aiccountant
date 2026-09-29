import { Entry } from '@napi-rs/keyring'
import type { Credentials } from '../core/contract'
import { parseCredentials, serializeCredentials } from '../collect/credentials-codec'

const SERVICE = 'aiccountant-collector'

export interface SecretStore {
  read(bank: string): Promise<Credentials | null>
  write(bank: string, credentials: Credentials): Promise<void>
  clear(bank: string): Promise<void>
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
