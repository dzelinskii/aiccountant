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

// Не ошибка, а повод дополнить перевод словаря в плагине: банк завёл группу,
// которой мы не знаем. Молчать об этом нельзя — такие операции доедут до
// приложения с видом unknown и тихо испортят картину по видам трат
export function reportUnknownKinds(appAccountId: string, operations: readonly CollectedOperation[]): void {
  const count = operations.filter((operation) => operation.kind === 'unknown').length
  if (count === 0) return
  console.log(`счёт ${appAccountId}: вид операции не распознан у ${count} — банк прислал незнакомую группу`)
}

// Тест на полноту справочника ловит дырку в таблице, но только для той версии
// справочника, что лежит в фикстуре. Банк заведёт новую категорию — фикстура
// устареет молча, и заметно это станет только здесь, на живых данных.
//
// Считаем только траты: у перевода, снятия наличных и прихода подсказки нет и
// быть не может, и попади они в знаменатель — счётчик рапортовал бы о дырке
// в справочнике там, где всё в порядке
export function reportMissingHints(appAccountId: string, operations: readonly CollectedOperation[]): void {
  const purchases = operations.filter((operation) => operation.kind === 'purchase')
  const count = purchases.filter((operation) => operation.category_hint === null).length
  if (count === 0) return
  console.log(`счёт ${appAccountId}: категория не определена у ${count} трат из ${purchases.length}`)
}

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
export function reportUnrefinedIncome(
  appAccountId: string,
  operations: readonly CollectedOperation[],
): void {
  const count = operations.filter((operation) => operation.kind === 'income').length
  if (count === 0) return
  console.log(`счёт ${appAccountId}: приход не разобран у ${count} — банк прислал незнакомую подгруппу`)
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
