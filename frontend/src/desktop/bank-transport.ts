import type { Transport } from 'aiccountant-collector/src/app'
import { invoke } from './runtime'

interface BankResponse {
  status: number
  body: string
}

/**
 * Транспорт ядра коллектора поверх команды оболочки bank_request. Список
 * адресов и доверие к УЦ проверяет Rust (desktop/src-tauri/src/banks.rs).
 * Сигнал отмены не пробрасывается: у запроса свой таймаут в оболочке (http.rs).
 */
export function bankTransport(bank: string): Transport {
  return {
    async send(url, { method, headers, body }) {
      // null, а не undefined: Tauri сериализует аргументы в JSON, а Rust ждёт Option<String>
      const res = await invoke<BankResponse>('bank_request', {
        bank,
        method,
        url: url.toString(),
        headers,
        body: body ?? null,
      }).catch((error: unknown) => {
        throw refusal(error)
      })
      return { status: res.status, ok: res.status >= 200 && res.status < 300, text: async () => res.body }
    },
  }
}

// BankClient не пробрасывает текст ошибки транспорта (в нём мог бы оказаться
// адрес с секретом), а берёт только name и code. Тексты отказов оболочки адреса
// не несут (http.rs describe, banks.rs check_request), поэтому причина — таймаут,
// сертификат, «не разрешено» — передаётся именно через code
function refusal(error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return Object.assign(new Error('Оболочка отказала в запросе'), { code: reason })
}
