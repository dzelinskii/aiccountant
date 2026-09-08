import type { BankPlugin } from '../core/contract'
import { tbankPlugin } from './tbank'

// Реестр намеренно плоский и явный: список банков виден целиком, без
// автозагрузки каталогов и магии по именам файлов
const PLUGINS: Record<string, BankPlugin> = {
  [tbankPlugin.name]: tbankPlugin,
}

export const BANK_NAMES: readonly string[] = Object.keys(PLUGINS)

export function pluginFor(name: string): BankPlugin {
  const plugin = PLUGINS[name]
  if (!plugin) {
    throw new Error(`Неизвестный банк "${name}". Известные: ${BANK_NAMES.join(', ')}`)
  }
  return plugin
}
