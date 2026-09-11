import type { BankPlugin } from '../core/contract'
import { createAlfaPlugin } from './alfa'
import { createSberPlugin } from './sber'
import { tbankPlugin } from './tbank'

export interface RegistryDeps {
  /**
   * Корень УЦ Минцифры добывается лениво и только тем банком, которому он
   * нужен. Требовать его заранее нельзя: тогда сбор по Т-Банку, которому чужой
   * УЦ не нужен вовсе, падал бы при недоступности точки раздачи сертификата.
   */
  loadCa: () => Promise<string>
}

// Реестр намеренно плоский и явный: список банков виден целиком, без
// автозагрузки каталогов и магии по именам файлов. Выбор через if/else, а не
// через объект-словарь: Сбербанку нужен асинхронно добытый корень
// сертификата, и лишний слой объекта с именем банка ключом снова открыл бы
// дорогу prototype pollution (см. историю этого файла и registry.test.ts) —
// здесь же имя банка нигде не используется как ключ доступа к чему-либо
export const BANK_NAMES: readonly string[] = [tbankPlugin.name, 'sber', 'alfa']

export async function pluginFor(name: string, deps: RegistryDeps): Promise<BankPlugin> {
  if (name === tbankPlugin.name) return tbankPlugin
  if (name === 'sber') return createSberPlugin({ ca: await deps.loadCa() })
  // Альфе, как и Сберу, нужен корень УЦ Минцифры — добывается лениво, тем же
  // способом, поэтому она автоматически получает и закрепление ключа в окне входа
  if (name === 'alfa') return createAlfaPlugin({ ca: await deps.loadCa() })
  throw new Error(`Неизвестный банк "${name}". Известные: ${BANK_NAMES.join(', ')}`)
}
