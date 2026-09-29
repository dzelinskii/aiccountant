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
      })
      return { status: res.status, ok: res.status >= 200 && res.status < 300, text: async () => res.body }
    },
  }
}
