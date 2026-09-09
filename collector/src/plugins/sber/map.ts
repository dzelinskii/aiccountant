import { hintFromMcc } from '../../core/category-hints'
import type { CollectedAccount, CollectedOperation } from '../../core/contract'

/**
 * Отображение ответа Сбербанка в нашу модель. Вход — результат parseLossless,
 * поэтому все числа уже строки: сумма так строкой и остаётся на всём пути
 * (правило проекта — деньги никогда не проходят через float).
 *
 * Как и у Т-Банка, запись, которую банк считает нашей операцией, но которую мы
 * не смогли разобрать, не пропускается молча — иначе банк переименует поле, и
 * сбор отрапортует успехом с пустым импортом. Намеренных тихих фильтра два:
 * isFinancial=false (это заявка, а не деньги) и операции чужой карты. Если же
 * счёт не назван банком нигде — ни в fromResource, ни в toResource, — это не
 * «чужая карта», а неразобранный ответ: такая запись роняет сбор, а не
 * тихо пропускается по той же ветке.
 */
export function toOperations(raw: readonly unknown[], accountId: string): CollectedOperation[] {
  const result: CollectedOperation[] = []
  for (const item of raw) {
    const operation = toOperation(item, accountId)
    if (operation) result.push(operation)
  }
  return result
}

function toOperation(item: unknown, accountId: string): CollectedOperation | null {
  if (!isRecord(item)) throw new Error('Операция в ответе банка пришла не объектом')

  // заявки (рефинансирование и подобное) приходят вперемешку с операциями и
  // денег не двигают; у них может не быть ни суммы, ни счёта
  if (item['isFinancial'] === false) return null

  const id = getStr(item, 'uohId')
  if (!id) throw new Error('У операции банка нет uohId')
  const context = `Операция ${id}`

  const match = matchesAccount(item, accountId)
  if (match === undefined) {
    throw new Error(`${context}: не удалось определить счёт операции — банк не прислал id ни в fromResource, ни в toResource`)
  }
  if (!match) return null

  const amount = requireAmount(item, context)
  const currency = requireCurrency(item, context)
  const description = getStr(item, 'description')
  const correspondent = getStr(item, 'correspondent')

  return {
    occurred_at: toIsoDate(getStr(item, 'date'), context),
    amount,
    currency,
    description: limitDescription(description && description.length > 0 ? description : (correspondent ?? '')),
    external_id: id,
    kind: resolveKind(item),
    category_hint: hintFromMcc(getStr(item, 'classificationCode')),
  }
}

/**
 * Обычно счёт операции лежит в одном поле в зависимости от направления: у
 * расхода в fromResource, у прихода в toResource. Но у перевода между своими
 * картами (UfsTransferSelf, 21 запись из 250 в разведке) заполнены оба —
 * банк описывает такую операцию с обеих сторон разом. Поэтому сторону не
 * выбирают по присутствию поля: операция наша, если запрошенный accountId
 * совпал хотя бы с одним из двух идентификаторов. Так спека (§7.2) выполняется
 * буквально независимо от того, что банк заполнил.
 *
 * undefined означает не «не наша операция», а «не поняли, чья»: банк не
 * прислал id ни в одном из полей, и это повод остановиться, а не тихо
 * пропустить запись — см. заголовок файла.
 */
function matchesAccount(item: Record<string, unknown>, accountId: string): boolean | undefined {
  const from = getRecord(item, 'fromResource')
  const fromId = from ? getStr(from, 'id') : undefined
  const to = getRecord(item, 'toResource')
  const toId = to ? getStr(to, 'id') : undefined
  if (fromId === undefined && toId === undefined) return undefined
  return fromId === accountId || toId === accountId
}

// Знак у Сбербанка уже в самой сумме — в отличие от Т-Банка, где направление
// задавалось отдельным полем. Перепутать это дорого: расход записался бы
// приходом, поэтому сумму со знаком принимаем как есть и не «исправляем»
function requireAmount(item: Record<string, unknown>, context: string): string {
  const block = getRecord(item, 'operationAmount')
  const raw = block ? getStr(block, 'amount') : undefined
  if (raw === undefined) throw new Error(`${context}: не удалось разобрать сумму операции`)
  if (isZeroAmount(raw)) throw new Error(`${context}: нулевая сумма операции — бэкенд её не примет`)
  return raw
}

// Минус в проверке обязателен: у Сбербанка знак уже в сумме (см. requireAmount
// выше), и банк вправе прислать "-0.00" — численно тот же ноль, что и "0.00",
// просто с сохранённым знаком. Без "-?" такая запись проскочила бы проверку и
// упала бы на бэкенде 422-м на всю пачку операций
function isZeroAmount(value: string): boolean {
  return /^-?0(\.0+)?$/.test(value)
}

const ALPHA3_CURRENCY = /^[A-Za-z]{3}$/

function requireCurrency(item: Record<string, unknown>, context: string): string {
  const block = getRecord(item, 'operationAmount')
  const code = block ? getStr(block, 'currencyCode') : undefined
  if (!code || !ALPHA3_CURRENCY.test(code)) {
    throw new Error(`${context}: не удалось распознать валюту (банк прислал "${code ?? ''}")`)
  }
  return code.toUpperCase()
}

// Банк отдаёт дату уже по Москве и без указания зоны: ДД.ММ.ГГГГTчч:мм:сс.
// Поэтому дату не пересчитываем, а переставляем — любой пересчёт через UTC
// увёл бы ночную операцию на предыдущие сутки, а на границе месяца испортил бы
// месячную статистику
const SBER_DATE = /^(\d{2})\.(\d{2})\.(\d{4})T\d{2}:\d{2}:\d{2}$/

function toIsoDate(value: string | undefined, context: string): string {
  const match = value ? SBER_DATE.exec(value) : null
  if (!match) throw new Error(`${context}: не удалось разобрать дату операции`)
  return `${match[3]}-${match[2]}-${match[1]}`
}

const MAX_DESCRIPTION_LENGTH = 1000 // предел ParsedOperationIn.description на бэкенде

function limitDescription(value: string): string {
  return value.length > MAX_DESCRIPTION_LENGTH ? value.slice(0, MAX_DESCRIPTION_LENGTH) : value
}

// Единственное место в системе, где живёт словарь Сбербанка. Значения собраны
// на живой выборке; список заведомо неполон, и это нормально — незнакомое
// значение даёт unknown и счётчик в выводе, а не остановку сбора.
//
// ExtCardPaymentRefund (возврат покупки) идёт в purchase, а не в отдельный вид:
// это содержательный выбор — сумма прихода уменьшает траты в категории, а не
// раздувает доход, что и требуется от возврата.
// UfsExtCardFee (комиссия карты) тоже идёт в purchase, но по другой причине —
// вынужденной: вида «комиссия» в словаре видов операций приложения нет.
//
// ExtCardOtherOut (14 записей из 250 в разведке) в словарь намеренно не
// попал: разведка не раскрыла смысл значения, а unknown со счётчиком в выводе
// честнее угадывания.
export const BANK_FORM_TO_KIND: Record<string, string> = {
  ExtCardPayment: 'purchase',
  UfsQRSBP: 'purchase',
  ExtCardPaymentRefund: 'purchase',
  UfsExtCardFee: 'purchase',
  UfsTransferSelf: 'transfer_self',
  P2PSBPInTransfer: 'transfer_person',
  UfsP2PSBPOutTransfer: 'transfer_person',
  UfsExtMMPLSBPOutNAcptTransfer: 'transfer_person',
  ExtCardTransferIn: 'transfer_person',
  ExtCardTransferOut: 'transfer_person',
  UfsTransferBankPartnerPhone: 'transfer_person',
  UfsOutTransfer: 'transfer_person',
  ExtCardCashIn: 'cash',
  ExtCardCashOut: 'cash',
}

/**
 * Виды, которые банк присылает регулярно, но которые мы намеренно НЕ переводим.
 * Такая операция получает вид `unknown`: остаётся видимой, попадает в
 * статистику, и счётчик в выводе сбора о ней сообщает.
 *
 * Перечислены здесь, а не только в коде разбора, чтобы попасть в справочник:
 * пропуск, о котором нигде не сказано, читается как забытая строка.
 */
export const UNMAPPED_BANK_FORMS: Record<string, string> = {
  ExtCardOtherOut:
    'буквально «прочее списание»; живой прогон дал 14 таких записей за месяц, ' +
    'все с MCC — то есть похожи на покупки, но подтверждения этому нет',
}

function resolveKind(item: Record<string, unknown>): string {
  const form = getStr(item, 'form')
  if (form === undefined) return 'unknown'
  // проверка на собственное свойство обязательна: справочник — обычный объект,
  // и форма вроде "toString" достала бы из прототипа функцию вместо вида
  if (!Object.hasOwn(BANK_FORM_TO_KIND, form)) return 'unknown'
  return BANK_FORM_TO_KIND[form] ?? 'unknown'
}

/** Идентификатор карты в том виде, в каком его принимает фильтр истории. */
export function cardResourceId(id: string): string {
  return `card:${id}`
}

/**
 * Единица счёта для Сбербанка — карта: история привязана к ней, а накопительные
 * счета из блока accounts своих операций не имеют вовсе. Как и у Т-Банка, список
 * счетов справочный, поэтому нераспознанная валюта или отсутствующий остаток
 * здесь дают null, а не останавливают сбор: иначе одна экзотическая карта
 * лишила бы человека подсказки с идентификаторами по всем остальным.
 */
export function toAccounts(raw: readonly unknown[]): CollectedAccount[] {
  return raw.map(toAccount)
}

function toAccount(item: unknown): CollectedAccount {
  if (!isRecord(item)) throw new Error('Карта в ответе банка пришла не объектом')
  const id = getStr(item, 'id')
  if (!id) throw new Error('У карты банка нет id')

  return {
    id: cardResourceId(id),
    name: getStr(item, 'name') ?? '',
    type: getStr(item, 'type') ?? '',
    currency: cardCurrency(item),
    balance: cardBalance(item),
    cardMasks: cardMask(item),
  }
}

// У дебетовой карты остаток — доступные средства (availableLimit). У кредитной
// он включает заёмные деньги и остатком в личных финансах не является: показать
// его как «сколько у меня есть» значило бы соврать на величину кредитного
// лимита. Поэтому у кредитки остатком считаются собственные средства —
// creditOwnSum, поле самой карты, а не вложенный блок creditType: тот приходит
// только с отдельной ручки cardInfo (детали конкретной карты), которую этот
// коллектор не вызывает.
//
// Сравнение регистронезависимое, а незнакомое значение type не считается ни
// кредитным, ни дебетовым — в отличие от tbank/map.ts (BLOCKED_CARD_STATUS),
// где нарочно проверяется известное нерабочее значение, чтобы новый статус
// банка не спрятал молча рабочую карту. Здесь риск обратный: поле выбирает
// между двумя разными по смыслу суммами, и creditOwnSum приходит у карт
// обоих типов — значит, само его наличие ничего не различает. Догадка на
// незнакомом значении type один раз подставила бы в остаток заёмные деньги,
// поэтому единственный безопасный выбор для незнакомого значения — не
// выбирать ничего.
function cardTypeKind(item: Record<string, unknown>): 'credit' | 'debit' | 'unknown' {
  const type = (getStr(item, 'type') ?? '').toLowerCase()
  if (type === 'credit') return 'credit'
  if (type === 'debit') return 'debit'
  return 'unknown'
}

function balanceSource(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const kind = cardTypeKind(item)
  if (kind === 'unknown') return undefined
  return getRecord(item, kind === 'credit' ? 'creditOwnSum' : 'availableLimit')
}

function cardBalance(item: Record<string, unknown>): string | null {
  const source = balanceSource(item)
  return source ? (getStr(source, 'amount') ?? null) : null
}

// Валюта — свойство карты, а не поля, выбранного под остаток: у кредитки без
// creditOwnSum (см. balanceSource) остаток честно уходит в null, но валюта у
// карты никуда не делась — она видна в availableLimit.currency. Поэтому здесь
// проверяются оба денежных блока карты, а не только тот, что достался под
// остаток.
function cardCurrency(item: Record<string, unknown>): string | null {
  return blockCurrency(getRecord(item, 'availableLimit')) ?? blockCurrency(getRecord(item, 'creditOwnSum'))
}

function blockCurrency(block: Record<string, unknown> | undefined): string | null {
  const currency = block ? getRecord(block, 'currency') : undefined
  const code = currency ? getStr(currency, 'code') : undefined
  return code && ALPHA3_CURRENCY.test(code) ? code.toUpperCase() : null
}

const FOUR_DIGIT_MASK = /^\d{4}$/

// Номер банк отдаёт уже замаскированным (2202 20** **** 1234); четыре цифры —
// ровно то, что принимает бэкенд в card_masks, и одна негодная метка ответила
// бы 422 на весь импорт вместе с операциями
function cardMask(item: Record<string, unknown>): string[] {
  const number = getStr(item, 'number')
  if (!number) return []
  const mask = number.replace(/\s/g, '').slice(-4)
  return FOUR_DIGIT_MASK.test(mask) ? [mask] : []
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
