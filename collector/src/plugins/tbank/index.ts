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

// В разведке подтверждён факт полей millisLeft/accessLevel в session_status,
// но не конкретные значения accessLevel для полного и урезанного доступа —
// такие эндпоинты нередко отвечают resultCode "OK" и на протухшую сессию,
// просто с пониженным уровнем доступа. Поэтому проверяем то, что можем
// проверить без гадания: millisLeft > 0 и что accessLevel вообще присутствует.
// Как только разведка подтвердит конкретные значения — сузить проверку
function assertSessionAlive(body: Record<string, unknown>): void {
  const millisLeft = toFiniteNumber(body['millisLeft'])
  if (millisLeft === undefined || millisLeft <= 0) {
    throw new SessionExpiredError('Сессия Т-Банка истекла (millisLeft <= 0)')
  }
  const accessLevel = body['accessLevel']
  if (typeof accessLevel !== 'string' || accessLevel.length === 0) {
    throw new SessionExpiredError('Сессия Т-Банка не даёт доступа (нет accessLevel)')
  }
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
