import type { BankPlugin } from '../core/contract'
import type { Transport } from '../http/transport'
import { createAlfaPlugin } from './alfa'
import { createSberPlugin } from './sber'
import { createTBankPlugin } from './tbank'

export interface RegistryDeps {
  /**
   * Транспорт к банку даёт вызывающий: у CLI это node:https с корнем УЦ
   * Минцифры, в приложении — оболочка (см. спеку десктопного клиента). Плагин
   * сам транспорт не выбирает.
   */
  transport: (bank: string) => Promise<Transport>
}

// Реестр намеренно плоский и явный: список банков виден целиком, без
// автозагрузки каталогов и магии по именам файлов. Выбор через if/else, а не
// через объект-словарь: имя банка нигде не становится ключом доступа, и имена
// из Object.prototype просто ни с чем не совпадают
export const BANK_NAMES: readonly string[] = ['tbank', 'sber', 'alfa']

export async function pluginFor(name: string, deps: RegistryDeps): Promise<BankPlugin> {
  if (name === 'tbank') return createTBankPlugin({ transport: await deps.transport(name) })
  if (name === 'sber') return createSberPlugin({ transport: await deps.transport(name) })
  if (name === 'alfa') return createAlfaPlugin({ transport: await deps.transport(name) })
  throw new Error(`Неизвестный банк "${name}". Известные: ${BANK_NAMES.join(', ')}`)
}
