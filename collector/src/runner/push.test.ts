import { expect, test, vi } from 'vitest'
import type { FetchImpl } from '../http/allowlist-client'
import type { CollectorConfig } from './config'
import { pushOperations } from './push'

const CONFIG: CollectorConfig = {
  apiBaseUrl: 'http://app.local',
  apiToken: 'secret-token',
  workspaceId: 'ws-1',
  accountMap: {},
  days: 30,
}

const OPERATIONS = [
  {
    occurred_at: '2026-07-05',
    amount: '-1150.50',
    currency: 'RUB',
    description: 'Кофейня',
    external_id: 'op-1',
    kind: 'purchase',
  },
]

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status })
}

test('операции уходят с токеном в заголовке и параметрами запроса', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () =>
    jsonResponse({ import_id: 'imp-1', status: 'ready' }, 201),
  )

  const result = await pushOperations(CONFIG, 'acc-app', OPERATIONS, fetchImpl)

  expect(result?.import_id).toBe('imp-1')
  const [url, init] = fetchImpl.mock.calls[0] ?? []
  const headers = init?.headers as Record<string, string> | undefined
  expect(String(url)).toContain('workspace_id=ws-1')
  expect(String(url)).toContain('account_id=acc-app')
  expect(headers?.['Authorization']).toBe('Bearer secret-token')
  expect(String(init?.body)).toContain('"parser":"tbank_collector"')
  // вид операции — часть договора с бэкендом: без него импорт молча вернётся
  // к unknown, и переводы снова попадут в расходы
  expect(String(init?.body)).toContain('"kind":"purchase"')
})

test('пустой список не отправляется', async () => {
  const fetchImpl = vi.fn<FetchImpl>()

  const result = await pushOperations(CONFIG, 'acc-app', [], fetchImpl)

  expect(result).toBeNull()
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('ошибка приложения не проглатывается', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ detail: 'Счёт не найден' }, 404))

  await expect(pushOperations(CONFIG, 'acc-app', OPERATIONS, fetchImpl)).rejects.toThrow(
    /404.*Счёт не найден/,
  )
})

test('в текст ошибки 422 не попадают суммы, описания и токен', async () => {
  // FastAPI кладёт в каждый элемент detail поле input с исходным значением
  // поля — подмешивание тела ответа целиком отправило бы покупки в консоль
  const fetchImpl = vi.fn<FetchImpl>(async () =>
    jsonResponse(
      {
        detail: [
          {
            type: 'decimal_parsing',
            loc: ['body', 'operations', 0, 'amount'],
            msg: 'Input should be a valid decimal',
            input: '-1150.50',
          },
          {
            type: 'string_too_long',
            loc: ['body', 'operations', 0, 'description'],
            msg: 'String should have at most 1000 characters',
            input: 'Кофейня',
          },
        ],
      },
      422,
    ),
  )

  const error = await pushOperations(CONFIG, 'acc-app', OPERATIONS, fetchImpl).catch(
    (e: unknown) => e,
  )
  const text = String(error)

  expect(text).toContain('422')
  expect(text).toContain('operations.0.amount')
  expect(text).toContain('Input should be a valid decimal')
  expect(text).not.toContain('1150.50')
  expect(text).not.toContain('Кофейня')
  expect(text).not.toContain('secret-token')
})

test('непонятное тело ответа даёт только код статуса', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () => new Response('<html>502</html>', { status: 502 }))

  await expect(pushOperations(CONFIG, 'acc-app', OPERATIONS, fetchImpl)).rejects.toThrow(/502/)
})

test('неожиданный успешный ответ не выдаётся за импорт', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ ok: true }, 201))

  await expect(pushOperations(CONFIG, 'acc-app', OPERATIONS, fetchImpl)).rejects.toThrow(
    /неожиданный ответ/,
  )
})
