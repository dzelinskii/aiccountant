import type { CollectedAccount, CollectedOperation } from './types'

/**
 * Отображение ответа Т-Банка в нашу модель. Вход — результат parseLossless,
 * поэтому все числа в нём уже строки; сумму так строкой и оставляем на всём
 * пути (правило проекта — деньги никогда не проходят через float). Дата —
 * исключение: миллисекунды с эпохи на много порядков меньше
 * Number.MAX_SAFE_INTEGER, точность там не теряется.
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
  const result: CollectedAccount[] = []
  for (const item of raw) {
    const account = toAccount(item)
    if (account) result.push(account)
  }
  return result
}

function toOperation(item: unknown): CollectedOperation | null {
  if (!isRecord(item)) return null
  const id = getStr(item, 'id')
  if (!id) return null
  if (getStr(item, 'status') !== 'OK') return null

  const operationTime = getRecord(item, 'operationTime')
  const millis = operationTime ? toMillis(operationTime['milliseconds']) : undefined
  if (millis === undefined) return null

  const accountAmount = getRecord(item, 'accountAmount')
  const rawValue = accountAmount ? toAmountString(accountAmount['value']) : undefined
  if (rawValue === undefined) return null

  const type = getStr(item, 'type') ?? ''
  const currencyRecord = accountAmount ? getRecord(accountAmount, 'currency') : undefined
  const strCode = currencyRecord ? getStr(currencyRecord, 'strCode') : undefined

  const merchant = getRecord(item, 'merchant')
  const merchantName = merchant ? getStr(merchant, 'name') : undefined
  const description = getStr(item, 'description')

  return {
    occurred_at: formatDate(millis),
    amount: withSign(rawValue, type),
    currency: strCode ? mapCurrency(strCode) : 'RUB',
    description: description && description.length > 0 ? description : (merchantName ?? ''),
    external_id: id,
  }
}

function toAccount(item: unknown): CollectedAccount | null {
  if (!isRecord(item)) return null
  const id = getStr(item, 'id')
  if (!id) return null

  const currencyRecord = getRecord(item, 'currency')
  const strCode = currencyRecord ? getStr(currencyRecord, 'strCode') : undefined

  return {
    id,
    name: getStr(item, 'name') ?? '',
    type: getStr(item, 'accountType') ?? '',
    currency: strCode ? mapCurrency(strCode) : 'RUB',
  }
}

// Знак — только по type: банк отдаёт value беззнаковой величиной что для
// Credit, что для Debit, минус в самом value ниоткуда не берётся
function withSign(value: string, type: string): string {
  return type === 'Debit' ? `-${value}` : value
}

// Транслируем только цифровой ISO-код рубля — это единственная валюта, с
// которой сегодня реально работает приложение. Для остальных кодов отдаём
// strCode как есть, а не молча подменяем на RUB: так рассинхронизация видна
// сразу (например, в проверке на границе бэкенда), а не прячется в отчётах
function mapCurrency(strCode: string): string {
  return strCode === '643' ? 'RUB' : strCode
}

function formatDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10)
}

function toMillis(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  return undefined
}

// В отличие от даты, сумму числом никогда не делаем — только строка на всём
// пути. Ветка для number оставлена на случай вызова функции напрямую с уже
// разобранным (не через parseLossless) объектом; боевой путь идёт строкой
function toAmountString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getStr(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}
