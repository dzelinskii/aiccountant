import type { CollectedOperation } from '../core/contract'

/**
 * Счётчики по итогам сбора — то, чем коллектор сообщает о расхождении своих
 * словарей с ответом банка. В консоль идут только идентификаторы и числа:
 * ни сумм, ни описаний операций.
 *
 * Живут отдельным модулем, а не в main.ts: main.ts — точка входа, он запускает
 * сбор прямо при импорте, и проверить эти счётчики тестом оттуда невозможно.
 * А врущий счётчик хуже отсутствующего: молчание он выдаёт за порядок.
 */

export interface CollectedCounters {
  /** Вид операции не распознан — банк прислал незнакомую группу. */
  unknownKinds: number
  /** Трат без подсказки о категории. */
  missingHints: number
  /** Всего трат — знаменатель для missingHints. */
  purchases: number
  /** Приходов, оставшихся доходом: подгруппу банка мы не знаем. */
  unrefinedIncome: number
}

/**
 * Считает счётчики итогов, ничего не печатая: экрану приложения нужны числа,
 * консоли — строки, и то и другое строится из этого подсчёта.
 */
export function countCollected(operations: readonly CollectedOperation[]): CollectedCounters {
  // Не ошибка, а повод дополнить перевод словаря в плагине: банк завёл группу,
  // которой мы не знаем. Молчать об этом нельзя: такие операции доедут до
  // приложения с видом unknown и тихо испортят картину по видам трат
  const unknownKinds = operations.filter((operation) => operation.kind === 'unknown').length

  // Тест на полноту справочника ловит дырку в таблице, но только для той версии
  // справочника, что лежит в фикстуре. Банк заведёт новую категорию — фикстура
  // устареет молча, и заметно это станет только здесь, на живых данных.
  //
  // Считаем только траты: у перевода, снятия наличных и прихода подсказки нет и
  // быть не может, и попади они в знаменатель — счётчик рапортовал бы о дырке
  // в справочнике там, где всё в порядке
  const purchases = operations.filter((operation) => operation.kind === 'purchase')
  const missingHints = purchases.filter((operation) => operation.category_hint === null).length

  // Таблица подгрупп закрывает то, что видели в живых данных владельца. Банк
  // заведёт новый код — операция останется доходом, и узнать об этом можно только
  // здесь: тесты сверяются с нашей таблицей, а не с тем, что банк присылает
  // сегодня.
  //
  // Считаем оставшиеся income, а не «незнакомые подгруппы»: ни одна строка
  // таблицы не ведёт в income (это закреплено тестом в map.test.ts), поэтому
  // доходом остаются ровно нераспознанные. Считать «все незнакомые подгруппы»
  // было бы неверно: подгруппы оплат и снятий в таблицу не входят намеренно, и
  // счётчик показывал бы сотню при нулевой проблеме.
  const unrefinedIncome = operations.filter((operation) => operation.kind === 'income').length

  return { unknownKinds, missingHints, purchases: purchases.length, unrefinedIncome }
}

export function reportUnknownKinds(appAccountId: string, operations: readonly CollectedOperation[]): void {
  const { unknownKinds } = countCollected(operations)
  if (unknownKinds === 0) return
  console.log(`счёт ${appAccountId}: вид операции не распознан у ${unknownKinds} — банк прислал незнакомую группу`)
}

export function reportMissingHints(appAccountId: string, operations: readonly CollectedOperation[]): void {
  const { missingHints, purchases } = countCollected(operations)
  if (missingHints === 0) return
  console.log(`счёт ${appAccountId}: категория не определена у ${missingHints} трат из ${purchases}`)
}

export function reportUnrefinedIncome(
  appAccountId: string,
  operations: readonly CollectedOperation[],
): void {
  const { unrefinedIncome } = countCollected(operations)
  if (unrefinedIncome === 0) return
  console.log(`счёт ${appAccountId}: приход не разобран у ${unrefinedIncome} — банк прислал незнакомую подгруппу`)
}

/**
 * Единственный вход для сбора: main.ts зовёт его, а не счётчики поодиночке.
 *
 * Причина в том, что проводку счётчиков нечем проверить. main.ts — точка входа,
 * он запускает сбор прямо при импорте, и тестом оттуда ничего не достать: убрать
 * вызов счётчика можно было так, что весь набор оставался зелёным. Три места,
 * где легко забыть, сведены в одно, и это одно закреплено тестом ниже. Осталась
 * одна непокрытая строка — вызов отсюда в main.ts, — и её стережёт линтер:
 * импорт без вызова роняет сборку.
 *
 * Заводя новый счётчик, добавляй его сюда — иначе он не будет вызван нигде.
 */
export function reportCollected(
  appAccountId: string,
  operations: readonly CollectedOperation[],
): void {
  reportUnknownKinds(appAccountId, operations)
  reportMissingHints(appAccountId, operations)
  reportUnrefinedIncome(appAccountId, operations)
}

/**
 * «1 счёт», «2 счёта», «11 счетов». Живёт здесь, а не в main.ts: main.ts
 * запускает сбор при импорте и тестом не достаётся, а у склонения три ветки
 * и исключение на второй десяток — как раз то, что молча ломается.
 */
export function accountsWord(count: number): string {
  const tail = count % 100
  if (tail >= 11 && tail <= 14) return `${count} счетов`
  const last = count % 10
  if (last === 1) return `${count} счёт`
  if (last >= 2 && last <= 4) return `${count} счёта`
  return `${count} счетов`
}
