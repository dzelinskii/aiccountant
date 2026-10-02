import type { FetchImpl } from './app-api'
import type { CollectedAccount, CollectedOperation } from '../core/contract'
import { appRequest } from './app-api'
import type { AppConnection } from './app-connection'

export interface PushResult {
  import_id: string
  status: string
}

/**
 * Отправка собранных операций в наше приложение.
 *
 * Возвращает null, если отправлять нечего: бэкенд пустой список не принимает.
 */
export async function pushOperations(
  connection: AppConnection,
  bank: string,
  accountId: string,
  operations: readonly CollectedOperation[],
  account: CollectedAccount | undefined,
  // без значения по умолчанию: глобальный fetch остаётся только в app-api.ts,
  // а appRequest сам подставляет его, если сюда ничего не передали
  fetchImpl?: FetchImpl,
): Promise<PushResult | null> {
  if (operations.length === 0) return null

  const data = await appRequest(
    connection,
    {
      method: 'POST',
      path: '/api/imports/parsed',
      params: { account_id: accountId },
      body: requestBody(bank, operations, account),
    },
    fetchImpl,
  )
  return parseResult(data)
}

/**
 * Блок про счёт необязателен: без него приложение оставит остаток и метки
 * прежними. Остаток в блоке обязателен, поэтому без него блок не отправляем
 * вовсе — иначе бэкенд отверг бы запрос целиком, вместе с операциями.
 * Имена полей здесь как в договоре API (`card_masks`), а не как внутри
 * коллектора. Имя парсера собирается из имени банка: заводить второй
 * справочник «банк → строка parser» значило бы держать два источника правды
 * об одном и том же.
 */
function requestBody(bank: string, operations: readonly CollectedOperation[], account: CollectedAccount | undefined): object {
  const body = { parser: `${bank}_collector`, operations }
  if (!account || account.balance === null) return body
  const block: Record<string, unknown> = { balance: account.balance, card_masks: account.cardMasks }
  // Лимита нет — про него в теле нет ничего. Для бэкенда отсутствие ключа и
  // null равнозначны, так что выбор в пользу формы покороче: у дебетовых счетов
  // сохранённый разбор остаётся таким же, каким был до появления лимита
  if (account.creditLimit !== null) block['credit_limit'] = account.creditLimit
  return { ...body, account: block }
}

function parseResult(data: unknown): PushResult {
  if (!isRecord(data) || typeof data['import_id'] !== 'string' || typeof data['status'] !== 'string') {
    throw new Error('Приложение вернуло неожиданный ответ на создание импорта')
  }
  return { import_id: data['import_id'], status: data['status'] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
