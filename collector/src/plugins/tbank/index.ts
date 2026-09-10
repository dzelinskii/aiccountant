import type { AllowlistClient } from '../../http/allowlist-client'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials, LoginPrompt } from '../../core/contract'
import { COMMON_PARAMS, createTBankClient } from './client'
import { obtainTBankToken } from './login'
import { toAccounts, toOperations } from './map'

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

// since/until здесь — epoch-миллисекунды, как и требует контракт (BankPlugin.fetchOperations);
// это же формат уходит в query банка (start/end) без промежуточного преобразования
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

// Оба кода означают одно для нас: предъявленный токен банк сессией не считает.
// SESSION_IS_ABSENT приходит на токен, который ещё (или уже) не авторизован,
// AUTHENTICATION_FAILED — когда токена нет вовсе. Лечится и то и другое только
// повторным входом, поэтому не путаем их с ошибками разбора ответа
const SESSION_RESULT_CODES = ['AUTHENTICATION_FAILED', 'SESSION_IS_ABSENT']

function assertOk(resultCode: string): void {
  if (resultCode === 'OK') return
  if (SESSION_RESULT_CODES.includes(resultCode)) {
    throw new SessionExpiredError(`Сессия Т-Банка недействительна (${resultCode}), нужен повторный вход`)
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
// Одного millisLeft мало: на мёртвой сессии банк отвечает resultCode "OK" и
// millisLeft около 11 минут — это счётчик анонимной сессии, а не нашей.
// Различает их accessLevel: "CLIENT" у входа под клиентом, "ANONYMOUS" когда
// входа нет. Проверяем именно известное мёртвое значение, а не равенство
// "CLIENT": появись у банка новый уровень доступа, обратная проверка отправила
// бы человека вводить код по кругу без всякой пользы.
const ANONYMOUS_ACCESS_LEVEL = 'ANONYMOUS'

function assertSessionAlive(body: Record<string, unknown>): void {
  if (findField(body, 'accessLevel') === ANONYMOUS_ACCESS_LEVEL) {
    throw new SessionExpiredError('Сессия Т-Банка анонимная — нужен вход')
  }
  const millisLeft = toFiniteNumber(findField(body, 'millisLeft'))
  if (millisLeft === undefined) {
    throw new Error(
      'Ответ session_status без числового millisLeft — устарел наш разбор ответа банка, повторный вход не поможет',
    )
  }
  if (millisLeft <= 0) {
    throw new SessionExpiredError('Сессия Т-Банка истекла (millisLeft <= 0)')
  }
}

// Живой запрос показал, что session_status кладёт данные в payload, как и
// остальные эндпоинты. Плоский конверт проверяем следом на случай, если у
// банка это когда-то различалось: цена — одна лишняя проверка словаря
function findField(body: Record<string, unknown>, name: string): unknown {
  const payload = body['payload']
  const places = isRecord(payload) ? [payload, body] : [body]
  for (const place of places) {
    const value = place[name]
    if (value !== undefined) return value
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

export const tbankPlugin: BankPlugin = {
  name: 'tbank',

  async login(prompt: LoginPrompt): Promise<Credentials> {
    // проверка живости обновлённого в фоне токена — забота плагина, а не
    // оболочки: она же и решает, нужен ли ещё видимый вход
    const token = await obtainTBankToken(prompt, (candidate) => isSessionAlive(createTBankClient(candidate)))
    return { kind: 'query', name: 'sessionid', value: token }
  },

  isAlive(credentials: Credentials): Promise<boolean> {
    return isSessionAlive(clientFor(credentials))
  },

  fetchAccounts(credentials: Credentials) {
    return fetchAccounts(clientFor(credentials))
  },

  fetchOperations(credentials: Credentials, accountId: string, since: number, until: number) {
    return fetchOperations(clientFor(credentials), accountId, since, until)
  },
}

async function isSessionAlive(client: AllowlistClient): Promise<boolean> {
  try {
    await checkSession(client)
    return true
  } catch (error) {
    if (error instanceof SessionExpiredError) return false
    throw error
  }
}

function clientFor(credentials: Credentials): AllowlistClient {
  if (credentials.kind !== 'query') {
    throw new Error('Т-Банк ожидает секрет в query — сохранённая запись не той формы')
  }
  return createTBankClient(credentials.value)
}
