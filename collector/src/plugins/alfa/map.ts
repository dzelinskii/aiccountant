import { hintFromMcc } from '../../core/category-hints'
import type { CollectedAccount, CollectedOperation } from '../../core/contract'

/**
 * Отображение ответа Альфа-Банка в нашу модель. Вход — результат parseLossless,
 * поэтому все числа уже строки: сумма так строкой и остаётся на всём пути
 * (правило проекта — деньги никогда через float, включая разбор).
 *
 * Слова Альфы живут только здесь. Как и у Т-Банка со Сбером, запись, которую
 * банк считает операцией, но которую мы не смогли разобрать (нет id, суммы,
 * валюты, направления или даты), не пропускается молча — иначе банк переименует
 * поле, и сбор отрапортует успехом с пустым импортом.
 */
export function toOperations(raw: readonly unknown[]): CollectedOperation[] {
  // accountId в разбор не передаётся намеренно: у операции Альфы поля счёта нет,
  // историю по счёту отбирает фильтр запроса (см. index.ts) — значит все
  // пришедшие записи и так принадлежат запрошенному счёту
  return raw.map(toOperation)
}

function toOperation(item: unknown): CollectedOperation {
  if (!isRecord(item)) throw new Error('Операция в ответе банка пришла не объектом')

  const id = getStr(item, 'id')
  if (!id) throw new Error('У операции банка нет id')
  const context = `Операция ${id}`

  const direction = requireDirection(item, context)

  return {
    occurred_at: toMoscowDate(getStr(item, 'dateTime'), context),
    amount: operationAmount(item, direction, context),
    currency: requireCurrency(item, context),
    description: limitDescription(describe(item)),
    external_id: id,
    kind: resolveKind(item, direction),
    category_hint: hintFromMcc(getStr(item, 'mcc')),
  }
}

// Направление — источник знака суммы (у Альфы value беззнаковый), поэтому его
// отсутствие или незнакомое значение это не «мелочь по умолчанию», а повод
// остановиться: перепутать расход с приходом дороже всего
function requireDirection(item: Record<string, unknown>, context: string): 'EXPENSE' | 'INCOME' {
  const direction = getStr(item, 'direction')
  if (direction === 'EXPENSE' || direction === 'INCOME') return direction
  throw new Error(`${context}: неизвестное направление операции "${direction ?? ''}"`)
}

function operationAmount(item: Record<string, unknown>, direction: 'EXPENSE' | 'INCOME', context: string): string {
  const block = getRecord(item, 'amount')
  const value = block ? getStr(block, 'value') : undefined
  const minorUnits = block ? getStr(block, 'minorUnits') : undefined
  if (value === undefined || minorUnits === undefined) throw new Error(`${context}: не удалось разобрать сумму`)
  // value у операции беззнаковый — знак несёт direction; берём модуль на случай,
  // если банк однажды пришлёт минус, чтобы он не сложился со знаком направления
  const magnitude = shiftByMinorUnits(stripSign(value), minorUnits, context)
  if (isZero(magnitude)) throw new Error(`${context}: нулевая сумма — бэкенд её не примет`)
  return direction === 'EXPENSE' ? `-${magnitude}` : magnitude
}

const ALPHA3 = /^[A-Za-z]{3}$/

// RUR — устаревший ISO-код рубля (ныне RUB); нормализуем, иначе бэкенд не
// узнает валюту. Прочие коды (CNY и т.п.) — как есть, в верхнем регистре
function normalizeCurrency(code: string): string {
  const upper = code.toUpperCase()
  return upper === 'RUR' ? 'RUB' : upper
}

function requireCurrency(item: Record<string, unknown>, context: string): string {
  const block = getRecord(item, 'amount')
  const code = block ? getStr(block, 'currency') : undefined
  if (!code || !ALPHA3.test(code)) throw new Error(`${context}: не удалось распознать валюту (банк прислал "${code ?? ''}")`)
  return normalizeCurrency(code)
}

// dateTime приходит с офсетом (…+03:00). Дату операции берём по московскому
// календарному дню: пересчёт через UTC увёл бы ночную операцию на прошлые сутки
// и на границе месяца испортил бы месячную статистику. Через Intl, а не срезом
// строки, — чтобы вывод не зависел от того, каким офсетом банк оформил время
const MOSCOW = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function toMoscowDate(value: string | undefined, context: string): string {
  if (!value) throw new Error(`${context}: у операции нет даты`)
  const millis = Date.parse(value)
  // значение даты в текст не кладём — держим правило «только идентификаторы»
  if (Number.isNaN(millis)) throw new Error(`${context}: не удалось разобрать дату операции`)
  // en-CA даёт формат YYYY-MM-DD, ровно как ждёт бэкенд
  return MOSCOW.format(new Date(millis))
}

function describe(item: Record<string, unknown>): string {
  const title = getStr(item, 'title') ?? ''
  const comment = getStr(item, 'comment') ?? ''
  // комментарий добавляем, только если он несёт что-то сверх заголовка
  if (comment && comment !== title) return title ? `${title}. ${comment}` : comment
  return title
}

const MAX_DESCRIPTION_LENGTH = 1000 // предел ParsedOperationIn.description на бэкенде

function limitDescription(value: string): string {
  return value.length > MAX_DESCRIPTION_LENGTH ? value.slice(0, MAX_DESCRIPTION_LENGTH) : value
}

/**
 * Единственное место в системе, где живёт словарь видов Альфы. Значения собраны
 * на живой выборке; список заведомо неполон — незнакомое значение даёт вид по
 * направлению (income/purchase), а не останавливает сбор.
 *
 * transfer_self ставится ТОЛЬКО по явному признаку «перевод себе» (me2me):
 * ошибка в другую сторону дороже. transfer_self исключён из статистики, поэтому
 * ложный transfer_self спрятал бы реальную трату; ложный transfer_person лишь
 * оставит перевод себе в статистике переводов. Настоящие переводы между своими
 * счетами (две ноги с одним clickReference) сводит приложение, а не догадка в
 * плагине по одной ноге.
 */
export const ALFA_OPERATION_TYPE_TO_KIND: Record<string, string> = {
  FAST_PAYMENT_SYSTEM_TRANSFER_ME2ME: 'transfer_self',
  FAST_PAYMENT_SYSTEM_TRANSFER: 'transfer_person',
  BASE_OUTGOING_TRANSFER: 'transfer_person',
  CARD2CARD_TRANSFER: 'transfer_person',
}

// category.id уточняет вид там, где operationType не пришёл: переводы несут
// direction EXPENSE/INCOME, но видом должны быть transfer_*, а не purchase/income
export const ALFA_CATEGORY_TO_KIND: Record<string, string> = {
  '00052': 'transfer_person',
  '50009': 'transfer_person',
}

/**
 * Виды, которые Альфа присылает, но которые мы намеренно НЕ уточняем в v1 —
 * перечислены, чтобы попасть в справочник: молчание о пропуске читалось бы как
 * полнота таблицы.
 *
 * - Снятие/внесение наличных (cash) и платёж по кредиту (loan) на разведочной
 *   выборке не встретились с надёжным признаком, а угадывать строку заголовка,
 *   которую не видел вживую, — ровно тот способ соврать убедительно, от которого
 *   предостерегает CLAUDE.md. До живого прогона такие операции получают вид по
 *   направлению (расход → purchase), а не выдуманный cash/loan.
 * - category «00025» (прочие расходы: комиссии, внутрибанковские) в таблицу не
 *   внесён намеренно — по направлению это purchase, отдельного вида «комиссия»
 *   в словаре приложения нет.
 */
export const UNMAPPED_ALFA_KINDS: Record<string, string> = {
  cash: 'снятие/внесение наличных — не встретилось на разведке с надёжным признаком; до живого прогона идёт по направлению',
  loan: 'платёж по кредиту — то же; вид loan добавим, когда увидим признак вживую',
}

function resolveKind(item: Record<string, unknown>, direction: 'EXPENSE' | 'INCOME'): string {
  // явный «перевод себе» — самый надёжный признак; заголовок как подстраховка
  // для ноги, у которой не пришёл operationType
  if ((getStr(item, 'title') ?? '').startsWith('Перевод себе')) return 'transfer_self'

  const operationType = operationTypeOf(item)
  if (operationType && Object.hasOwn(ALFA_OPERATION_TYPE_TO_KIND, operationType)) {
    return ALFA_OPERATION_TYPE_TO_KIND[operationType] ?? base(direction)
  }

  const categoryId = categoryIdOf(item)
  if (categoryId && Object.hasOwn(ALFA_CATEGORY_TO_KIND, categoryId)) {
    return ALFA_CATEGORY_TO_KIND[categoryId] ?? base(direction)
  }

  return base(direction)
}

function base(direction: 'EXPENSE' | 'INCOME'): string {
  return direction === 'INCOME' ? 'income' : 'purchase'
}

// operationType лежит в actions[].operationType (у действия «повторить»), не на
// верхнем уровне и не всегда — поэтому ищем в массиве действий, а не по ключу
function operationTypeOf(item: Record<string, unknown>): string | undefined {
  const actions = item['actions']
  if (!Array.isArray(actions)) return undefined
  for (const action of actions) {
    if (isRecord(action)) {
      const type = getStr(action, 'operationType')
      if (type) return type
    }
  }
  return undefined
}

function categoryIdOf(item: Record<string, unknown>): string | undefined {
  const category = getRecord(item, 'category')
  return category ? getStr(category, 'id') : undefined
}

/**
 * Единица счёта у Альфы — счёт (история фильтруется по его номеру, карты к нему
 * привязаны). Инвестиционные (GK) и металлические счета исключаются: истории
 * операций в понимании леджера у них нет, а исключение попутно снимает
 * неуникальность id у мультивалютного брокерского счёта (один номер, разные
 * валюты). Список справочный, поэтому нераспознанная валюта или отсутствующий
 * остаток дают null, а не останавливают сбор.
 */
export function toAccounts(rawAccounts: readonly unknown[], rawCards: readonly unknown[]): CollectedAccount[] {
  const masksByAccount = cardMasksByAccount(rawCards)
  const result: CollectedAccount[] = []
  for (const item of rawAccounts) {
    if (!isRecord(item)) throw new Error('Счёт в ответе банка пришёл не объектом')
    if (isExcludedAccount(item)) continue
    const number = getStr(item, 'number')
    if (!number) throw new Error('У счёта банка нет номера')
    result.push({
      id: number,
      name: getStr(item, 'description') ?? '',
      type: getStr(item, 'type') ?? '',
      currency: accountCurrency(item),
      balance: accountBalance(item),
      cardMasks: masksByAccount.get(number) ?? [],
    })
  }
  return result
}

// GK — брокерские, плюс металлические (по описанию). Исключаем по типу и по
// описанию: тип надёжнее, описание ловит металлические, у которых свой тип
const EXCLUDED_ACCOUNT_TYPES = new Set(['GK'])
const METAL_DESCRIPTION = /драг|металл/i

function isExcludedAccount(item: Record<string, unknown>): boolean {
  const type = getStr(item, 'type') ?? ''
  if (EXCLUDED_ACCOUNT_TYPES.has(type)) return true
  return METAL_DESCRIPTION.test(getStr(item, 'description') ?? '')
}

// Остаток кредитки — total (чистая собственная позиция, уходит в минус при
// долге), а НЕ amount: amount у кредитки это доступно к трате (лимит + своё −
// холды) и показал бы заёмные деньги как собственные. У дебетового счёта
// amount == total, так что для него выбор безразличен, — берём total всегда.
function accountBalance(item: Record<string, unknown>): string | null {
  const block = getRecord(item, 'total')
  const value = block ? getStr(block, 'value') : undefined
  const minorUnits = block ? getStr(block, 'minorUnits') : undefined
  if (value === undefined || minorUnits === undefined) return null
  return signedMinor(value, minorUnits)
}

// Валюта — свойство счёта; берём из total, а если там негодно — из amount:
// остаток мог не прийти, но валюта у счёта никуда не делась
function accountCurrency(item: Record<string, unknown>): string | null {
  return blockCurrency(getRecord(item, 'total')) ?? blockCurrency(getRecord(item, 'amount'))
}

function blockCurrency(block: Record<string, unknown> | undefined): string | null {
  const code = block ? getStr(block, 'currency') : undefined
  return code && ALPHA3.test(code) ? normalizeCurrency(code) : null
}

const FOUR_DIGIT_MASK = /^\d{4}$/

function cardMasksByAccount(rawCards: readonly unknown[]): Map<string, string[]> {
  const byAccount = new Map<string, string[]>()
  for (const card of rawCards) {
    if (!isRecord(card)) continue
    const account = getRecord(card, 'account')
    const accountNumber = account ? getStr(account, 'number') : undefined
    if (!accountNumber) continue
    const number = getStr(card, 'number')
    if (!number) continue
    const mask = number.replace(/\D/g, '').slice(-4)
    if (!FOUR_DIGIT_MASK.test(mask)) continue
    const list = byAccount.get(accountNumber) ?? []
    list.push(mask)
    byAccount.set(accountNumber, list)
  }
  return byAccount
}

// --- деньги: value (целое в минорных единицах) + minorUnits (делитель) ---

// Сдвиг беззнакового целого на разряды minorUnits. minorUnits обязан быть
// степенью десяти (1, 10, 100…): банк присылает 100 для рубля, а любое другое
// значение — сигнал, что форма ответа поменялась, и это повод упасть, а не
// молча посчитать неверно
function shiftByMinorUnits(digits: string, minorUnits: string, context: string): string {
  // ни сумму (digits), ни делитель в текст ошибки не кладём: это монетарное
  // значение из ответа банка, а суммы в логи не пишутся (CLAUDE.md, спека §9)
  if (!/^\d+$/.test(digits)) throw new Error(`${context}: сумма пришла не целым числом`)
  if (!/^10*$/.test(minorUnits)) throw new Error(`${context}: неожиданный делитель суммы`)
  const places = minorUnits.length - 1
  const trimmed = digits.replace(/^0+(?=\d)/, '')
  if (places === 0) return trimmed
  const padded = trimmed.padStart(places + 1, '0')
  const int = padded.slice(0, padded.length - places)
  const frac = padded.slice(padded.length - places)
  return `${int}.${frac}`
}

// Остаток счёта, в отличие от суммы операции, приходит со знаком в самом value
// (кредитка в минусе). Знак сохраняем, но "-0.00" не производим
function signedMinor(value: string, minorUnits: string): string {
  const negative = value.startsWith('-')
  const magnitude = shiftByMinorUnits(negative ? value.slice(1) : value, minorUnits, 'Остаток счёта')
  return negative && !isZero(magnitude) ? `-${magnitude}` : magnitude
}

function stripSign(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value
}

function isZero(decimal: string): boolean {
  return /^0(\.0+)?$/.test(decimal)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getStr(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}
