import type { AllowlistClient } from '../../http/allowlist-client'
import { COMMON_PARAMS } from './client'
import { toAccounts, toOperations } from './map'
import type { CollectedAccount, CollectedOperation } from './types'

/** Токен протух: сессия Т-Банка истекла и нужен новый вход через браузер. */
export class SessionExpiredError extends Error {}

export async function checkSession(client: AllowlistClient): Promise<void> {
  const raw = await client.getJson('/api/common/v1/session_status', { ...COMMON_PARAMS })
  const envelope = parseEnvelope(raw)
  assertOk(envelope.resultCode)
  assertSessionAlive(envelope.body)
}

export async function fetchAccounts(client: AllowlistClient): Promise<CollectedAccount[]> {
  const payload = await requestPayload(client, '/api/common/v1/accounts_light_ib', {})
  return toAccounts(payload)
}

// since/until — epoch-миллисекунды, а не Date: это ровно формат, который уходит
// в query банка (start/end), и раннер (Task 6) вызывает функцию этой же
// сигнатурой — конвертация Date -> ms при таком разбиении просто переехала бы
// на вызывающую сторону без реальной необходимости
export async function fetchOperations(
  client: AllowlistClient,
  accountId: string,
  since: number,
  until: number = Date.now(),
): Promise<CollectedOperation[]> {
  const payload = await requestPayload(client, '/mybank/api/operations/timeline/public/legacy/v1/operations', {
    account: accountId,
    start: String(since),
    end: String(until),
  })
  return toOperations(payload)
}

async function requestPayload(client: AllowlistClient, path: string, params: Record<string, string>): Promise<unknown[]> {
  const raw = await client.getJson(path, { ...COMMON_PARAMS, ...params })
  const envelope = parseEnvelope(raw)
  assertOk(envelope.resultCode)
  const payload = envelope.body['payload']
  // молчаливая подмена не-массива на [] на этом уровне неотличима от «банк
  // и правда прислал 0 операций» — тот же класс проблемы, что и с map.ts
  if (!Array.isArray(payload)) throw new Error(`Банк вернул payload не массивом (${path})`)
  return payload
}

interface Envelope {
  resultCode: string
  body: Record<string, unknown>
}

// resultCode проверяем до того, как требовать что-либо ещё от тела ответа:
// на AUTHENTICATION_FAILED и подобные payload может отсутствовать вовсе, и
// это не повод потерять специфичную ошибку за общим "неожиданный формат"
function parseEnvelope(data: unknown): Envelope {
  if (!isRecord(data)) throw new Error('Банк вернул неожиданный формат ответа')
  const resultCode = data['resultCode']
  if (typeof resultCode !== 'string') throw new Error('Банк вернул неожиданный формат ответа')
  return { resultCode, body: data }
}

function assertOk(resultCode: string): void {
  if (resultCode === 'OK') return
  if (resultCode === 'AUTHENTICATION_FAILED') {
    throw new SessionExpiredError('Сессия Т-Банка истекла, нужен повторный вход')
  }
  throw new Error(`Банк вернул ошибку: ${resultCode}`)
}

// «Сессия истекла» и «ответ не той формы, что мы ожидали» — разные случаи, и
// смешивать их нельзя: первый лечится повторным входом, второй не лечится им
// никогда. Если на живой куке не найденный millisLeft объявить истёкшей
// сессией, получится круг «достали живую куку → не нашли поле → окно входа →
// человек ввёл код → тот же ответ → опять окно входа», и каждый его виток
// врёт про причину. Поэтому непонятный ответ — обычная ошибка разбора.
//
// accessLevel не проверяем: его наличие ничего не говорит о живости сессии, а
// конкретные значения для полного и урезанного доступа разведкой не сняты.
// Когда они станут известны — здесь появится настоящая проверка уровня доступа.
function assertSessionAlive(body: Record<string, unknown>): void {
  const millisLeft = findMillisLeft(body)
  if (millisLeft === undefined) {
    throw new Error(
      'Ответ session_status без числового millisLeft — устарел наш разбор ответа банка, повторный вход не поможет',
    )
  }
  if (millisLeft <= 0) {
    throw new SessionExpiredError('Сессия Т-Банка истекла (millisLeft <= 0)')
  }
}

// Реального ответа session_status у нас нет: остальные эндпоинты этого API
// кладут данные в payload, но плоский конверт тоже возможен. Проверяем оба
// места, пока живой запрос не покажет, какое из них настоящее
function findMillisLeft(body: Record<string, unknown>): number | undefined {
  const payload = body['payload']
  const places = isRecord(payload) ? [payload, body] : [body]
  for (const place of places) {
    const millisLeft = toFiniteNumber(place['millisLeft'])
    if (millisLeft !== undefined) return millisLeft
  }
  return undefined
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
