import type { BankPlugin } from '../core/contract'
import { tbankPlugin } from './tbank'

// Реестр намеренно плоский и явный: список банков виден целиком, без
// автозагрузки каталогов и магии по именам файлов
const PLUGINS: Record<string, BankPlugin> = {
  [tbankPlugin.name]: tbankPlugin,
}

export const BANK_NAMES: readonly string[] = Object.keys(PLUGINS)

export function pluginFor(name: string): BankPlugin {
  // проверка на собственное свойство обязательна: PLUGINS — обычный объект, и
  // имя вроде "toString" или "__proto__" достало бы значение из прототипа
  // вместо честного отказа — а дальше такое имя уйдёт ключом секрета в
  // хранилище ОС и именем парсера в импорт
  if (!Object.hasOwn(PLUGINS, name)) {
    throw new Error(`Неизвестный банк "${name}". Известные: ${BANK_NAMES.join(', ')}`)
  }
  return PLUGINS[name]!
}
