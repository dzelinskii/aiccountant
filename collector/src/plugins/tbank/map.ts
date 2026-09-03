import type { CollectedAccount, CollectedOperation } from './types'

/**
 * Отображение ответа Т-Банка в нашу модель. Вход — результат parseLossless,
 * поэтому все числа в нём уже строки; сумму так строкой и оставляем на всём
 * пути (правило проекта — деньги никогда не проходят через float). Дата —
 * исключение: миллисекунды с эпохи на много порядков меньше
 * Number.MAX_SAFE_INTEGER, точность там не теряется.
 *
 * Отдельный принцип: запись, у которой есть id и статус OK (то есть банк
 * считает её нашей операцией), но которую мы не можем разобрать — не
 * пропускаем молча, а бросаем исключение. Тихий пропуск неотличим по счётчику
 * от «пришло 8285, отдали 8285»: банк переименует поле — и весь сбор
 * отрапортует успехом с пустым импортом. Единственный намеренный тихий
 * фильтр — status !== "OK": это не наши деньги, а не непонятный ответ банка.
 */
export function toOperations(raw: readonly unknown[]): CollectedOperation[] {
  const result: CollectedOperation[] = []
  for (const item of raw) {
    const operation = toOperation(item)
    if (operation) result.push(operation)
  }
  return result
}

export function toAccounts(raw: readonly unknown[]): CollectedAccount[] {
  return raw.map(toAccount)
}

function toOperation(item: unknown): CollectedOperation | null {
  if (!isRecord(item)) {
    throw new Error('Операция в ответе банка пришла не объектом')
  }
  const status = getStr(item, 'status')
  if (status !== 'OK') return null // намеренно: FAILED и подобные — не наши деньги, а не сбой разбора

  const id = getStr(item, 'id')
  if (!id) throw new Error('У операции банка со статусом OK нет id')
  const context = `Операция ${id}`

  const operationTime = getRecord(item, 'operationTime')
  const millis = operationTime ? toMillis(operationTime['milliseconds']) : undefined
  if (millis === undefined) throw new Error(`${context}: не удалось разобрать дату операции`)

  const accountAmount = getRecord(item, 'accountAmount')
  const rawValue = accountAmount ? toAmountString(accountAmount['value']) : undefined
  if (rawValue === undefined) throw new Error(`${context}: не удалось разобрать сумму операции`)

  const type = getStr(item, 'type') ?? ''
  const currencyRecord = accountAmount ? getRecord(accountAmount, 'currency') : undefined

  const merchant = getRecord(item, 'merchant')
  const merchantName = merchant ? getStr(merchant, 'name') : undefined
  const description = getStr(item, 'description')

  return {
    occurred_at: formatDate(millis),
    amount: signedAmount(rawValue, type, context),
    currency: requireCurrency(currencyRecord, context),
    description: limitDescription(description && description.length > 0 ? description : (merchantName ?? '')),
    external_id: id,
    kind: resolveKind(item),
  }
}

// Список счетов справочный: он нужен, чтобы человек нашёл идентификаторы и
// настроил коллектор. Счетов в ЛК много и типы у них разные — валютный счёт
// или счёт без блока currency вполне ожидаем. Роняй список такой счёт, и
// собрать не выйдет ничего, включая рублёвые счета, которые разбираются
// нормально, а подсказку с идентификаторами взять станет негде. Поэтому здесь
// нераспознанная валюта — null, а строгость остаётся у операций, где неверная
// валюта означает неверные деньги
function toAccount(item: unknown): CollectedAccount {
  if (!isRecord(item)) {
    throw new Error('Счёт в ответе банка пришёл не объектом')
  }
  const id = getStr(item, 'id')
  if (!id) throw new Error('У счёта банка нет id')

  return {
    id,
    name: getStr(item, 'name') ?? '',
    type: getStr(item, 'accountType') ?? '',
    currency: resolveCurrency(getRecord(item, 'currency')),
    balance: resolveBalance(item),
    cardMasks: resolveCardMasks(item),
  }
}

// Остаток — та же строка, что и суммы операций: через число деньги не проходят.
// Нет блока или значение не строкой — null, а не остановка: остаток дополняет
// сбор, и терять из-за него операции счёта несоразмерно
function resolveBalance(item: Record<string, unknown>): string | null {
  const moneyAmount = getRecord(item, 'moneyAmount')
  if (!moneyAmount) return null
  return toAmountString(moneyAmount['value']) ?? null
}

const MASK_LENGTH = 4
// Проверяем известное «нерабочее» значение, а не равенство «Активна»: заведи
// банк новый статус, и обратная проверка молча спрятала бы рабочую карту
const BLOCKED_CARD_STATUS = 'Заблокирована'

// Метка нужна, чтобы человек узнал свой счёт в приложении, поэтому первой идёт
// основная карта — та, которой платят. Номер банк отдаёт уже замаскированным;
// последние символы из него берём потому, что больше для узнавания не нужно
function resolveCardMasks(item: Record<string, unknown>): string[] {
  const cards = item['cards']
  if (!Array.isArray(cards)) return []
  const usable = cards.filter(isRecord).filter((card) => getStr(card, 'status') !== BLOCKED_CARD_STATUS)
  const ordered = [...usable.filter(isPrimaryCard), ...usable.filter((card) => !isPrimaryCard(card))]

  const masks: string[] = []
  for (const card of ordered) {
    const number = getStr(card, 'number')
    // карта без номера метки не даёт: пустая метка не пройдёт проверку бэкенда
    // и уронит 422 на весь импорт вместе с операциями
    if (!number) continue
    masks.push(number.slice(-MASK_LENGTH))
  }
  return masks
}

function isPrimaryCard(card: Record<string, unknown>): boolean {
  return card['primary'] === true
}

// Бэкенд (ParsedOperationIn._amount_not_zero, backend/app/imports/schemas.py)
// отдельно отвергает нулевую сумму, а "--5" от двойного знака уронит decimal_parsing.
// ParsedImportIn.operations — список, pydantic валидирует его целиком, поэтому
// одна такая запись даёт 422 на весь запрос — тысячи нормальных операций
// до бэкенда в этом случае не доедут. Дешевле отсечь на своей стороне
function signedAmount(rawValue: string, type: string, context: string): string {
  if (rawValue.startsWith('-')) {
    // По нашим наблюдениям банк всегда отдаёт value беззнаковой величиной,
    // знак — отдельно, в type. Возвраты и отмены — как раз то место, где
    // это предположение о чужом API может однажды не подтвердиться. Если
    // угадать знак неправильно, "--5" на бэкенде превратится в decimal_parsing
    // и уронит всю пачку операций — лучше остановиться и разобраться руками.
    // Саму сумму в текст не подставляем: сообщение видно в консоли, а суммам
    // там не место — операция ищется по идентификатору из context
    throw new Error(`${context}: сумма от банка пришла уже со знаком — не ожидали`)
  }
  if (type !== 'Debit' && type !== 'Credit') {
    // Неизвестный type молча трактовать как доход нельзя: "Transfer" или
    // отсутствующее поле дали бы положительную сумму, и расход записался бы
    // в леджер как приход
    throw new Error(`${context}: неизвестный тип операции "${type}" (ожидался Credit или Debit)`)
  }
  if (isZeroAmount(rawValue)) {
    throw new Error(`${context}: нулевая сумма операции — бэкенд её не примет`)
  }
  return type === 'Debit' ? `-${rawValue}` : rawValue
}

// "0", "0.0", "0.00" — численно ноль независимо от числа нулей после точки;
// строковым сравнением с одним литералом это не поймать
function isZeroAmount(value: string): boolean {
  return /^0(\.0+)?$/.test(value)
}

const MAX_DESCRIPTION_LENGTH = 1000 // ровно предел ParsedOperationIn.description на бэкенде

function limitDescription(value: string): string {
  return value.length > MAX_DESCRIPTION_LENGTH ? value.slice(0, MAX_DESCRIPTION_LENGTH) : value
}

// Единственное место в системе, где живёт словарь Т-Банка. Приложение работает
// своими терминами и про PAY/INTERNAL не знает: иначе знание об одном банке
// протекло бы в ядро домена и каждый новый банк правился бы там же.
const BANK_GROUP_TO_KIND: Record<string, string> = {
  PAY: 'purchase',
  TRANSFER: 'transfer_person',
  INTERNAL: 'transfer_self',
  CASH: 'cash',
  LOANREPAY: 'loan',
  INCOME: 'income',
}

// В отличие от суммы и валюты, незнакомая группа — не повод останавливаться:
// банк вправе завести новое значение в любой момент, и терять из-за этого
// операцию нельзя. unknown из статистики не исключается, поэтому такая операция
// остаётся видимой, а расхождение словарей заметно по счётчику в выводе сбора
function resolveKind(item: Record<string, unknown>): string {
  const group = getStr(item, 'group')
  if (group === undefined) return 'unknown'
  // проверка на собственное свойство обязательна: справочник — обычный объект,
  // и группа вроде "toString" достала бы из прототипа функцию вместо вида
  if (!Object.hasOwn(BANK_GROUP_TO_KIND, group)) return 'unknown'
  return BANK_GROUP_TO_KIND[group] ?? 'unknown'
}

const ALPHA3_CURRENCY = /^[A-Za-z]{3}$/
// Подтверждено разведкой только про рубль; остальные коды маппить не на чем
const KNOWN_NUMERIC_CURRENCIES: Record<string, string> = { '643': 'RUB' }

// Живой прогон показал в strCode буквенный код (видели "RUB" и "USD"), но
// числовой ISO 4217 не исключён: набор валют в выборке был маленький, а имя
// поля говорит скорее про код-строку, чем про формат. Поэтому проверяем оба
// поля (strCode и name) и оба формата. Числовой код, которого нет в KNOWN_NUMERIC_CURRENCIES,
// намеренно не подставляем как есть: бэкенд сверяет currency операции с
// currency счёта (backend/app/imports/router.py), а счета заводятся
// буквенными кодами ("RUB") — числовой код там не совпадёт ни с чем и уронит
// 422 на весь запрос с сообщением про "несовпадение валюты счёта", хотя
// причина на самом деле в формате кода.
//
// null — валюту распознать не удалось: незнакомый числовой код, чужой формат
// или вовсе нет блока currency
function resolveCurrency(currency: Record<string, unknown> | undefined): string | null {
  const candidates = currencyCandidates(currency)
  for (const candidate of candidates) {
    if (ALPHA3_CURRENCY.test(candidate)) return candidate.toUpperCase()
  }
  for (const candidate of candidates) {
    // проверка на цифры не только отсекает нечисловые коды: без неё в поиск по
    // объекту-справочнику проходят имена из прототипа ("toString"), и валютой
    // стало бы что угодно, кроме валюты
    if (!/^\d+$/.test(candidate)) continue
    const known = KNOWN_NUMERIC_CURRENCIES[candidate]
    if (known) return known
  }
  return null
}

function currencyCandidates(currency: Record<string, unknown> | undefined): string[] {
  if (!currency) return []
  const candidates = [getStr(currency, 'strCode'), getStr(currency, 'name')]
  return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
}

// Для операции нераспознанная валюта — остановка: молча взятый не тот код
// означает не те деньги в леджере, а поход на бэкенд с ним всё равно кончится
// 422 на всю пачку, только с сообщением не про ту причину. Код валюты в
// сообщении нужен — по нему сразу видно, незнакомая это валюта или незнакомый
// формат кода; сумм и описаний в тексте по-прежнему нет
function requireCurrency(currency: Record<string, unknown> | undefined, context: string): string {
  const resolved = resolveCurrency(currency)
  if (resolved !== null) return resolved
  const seen = currencyCandidates(currency)
  const codes = seen.length > 0 ? ` (банк прислал ${seen.map((code) => `"${code}"`).join(', ')})` : ''
  throw new Error(`${context}: не удалось распознать валюту${codes}`)
}

// Банк показывает операции по московскому времени (это видно и по его же
// запросам — фронт передаёт timeZone=+03:00), а дашборд считает статистику по
// календарному месяцу. Дата в UTC для ночной операции могла бы уехать на
// предыдущие сутки, а на границе месяца — ещё и исказить месячную статистику.
// en-CA гарантированно даёт формат ГГГГ-ММ-ДД только при наличии данных этой
// локали в рантайме — на урезанном ICU (в том числе в мобильных движках) он
// молча откатывается на другой формат, который бэкенд отвергнет. formatToParts
// не зависит от локали вообще, только от порядка полей, который мы задаём сами
const MOSCOW_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function formatDate(millis: number): string {
  const parts = MOSCOW_PARTS.formatToParts(new Date(millis))
  const year = partValue(parts, 'year')
  const month = partValue(parts, 'month')
  const day = partValue(parts, 'day')
  return `${year}-${month}-${day}`
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((p) => p.type === type)
  if (!part) throw new Error(`Не удалось получить часть даты "${type}"`)
  return part.value
}

// ECMA-262: максимальное валидное время для Date — за этой границей
// new Date(millis) создаёт "Invalid Date", а форматирование такой даты
// бросает RangeError без указания, какая операция тому виной
const MAX_VALID_MILLIS = 8_640_000_000_000_000

function toMillis(value: unknown): number | undefined {
  if (typeof value === 'number') return isValidMillis(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return isValidMillis(num) ? num : undefined
  }
  // пустая строка отдельно: Number('') === 0 молча дал бы 1970-01-01
  return undefined
}

function isValidMillis(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_VALID_MILLIS
}

// Сумму числом никогда не делаем — только строка. Ветки для JS number здесь
// нет: это тот самый баг, который весь модуль предотвращает (String(большое
// число с плавающей точкой) уже потерял бы разряды до вызова этой функции) —
// боевой путь всегда идёт строкой из parseLossless
function toAmountString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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
