import { expect, test } from 'vitest'
import type { FetchImpl } from '../http/allowlist-client'
import { AppHttpError, appRequest } from './app-api'
import type { AppConnection } from './app-connection'

const config: AppConnection = {
  baseUrl: 'http://app.local',
  workspaceId: 'ws-1',
  authorization: 'Bearer secret-token',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

test('workspace_id подставляется всегда, а не только когда вызывающий про него помнит', async () => {
  const calls: [string, RequestInit | undefined][] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push([String(url), init])
    return jsonResponse({ ok: true })
  }

  await appRequest(config, { method: 'GET', path: '/api/accounts' }, fetchImpl)

  const [url] = calls[0]!
  expect(url).toContain('/api/accounts?')
  expect(url).toContain('workspace_id=ws-1')
})

test('дополнительные параметры уходят рядом с workspace_id', async () => {
  const calls: [string, RequestInit | undefined][] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push([String(url), init])
    return jsonResponse({ ok: true })
  }

  await appRequest(config, { method: 'PUT', path: '/api/accounts/discovered', params: { bank: 'alfa' } }, fetchImpl)

  const [url] = calls[0]!
  expect(url).toContain('workspace_id=ws-1')
  expect(url).toContain('bank=alfa')
})

test('метод, токен и тело уходят как задано вызывающим', async () => {
  const calls: [string, RequestInit | undefined][] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push([String(url), init])
    return jsonResponse({ ok: true }, 201)
  }

  await appRequest(config, { method: 'POST', path: '/api/accounts', body: { name: 'Карта' } }, fetchImpl)

  const [, init] = calls[0]!
  const headers = init?.headers as Record<string, string>
  expect(init?.method).toBe('POST')
  expect(headers['Authorization']).toBe('Bearer secret-token')
  expect(String(init?.body)).toBe(JSON.stringify({ name: 'Карта' }))
})

test('заголовок Authorization берётся из соединения целиком: сессия приложения — не Bearer', async () => {
  const calls: [string, RequestInit | undefined][] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push([String(url), init])
    return jsonResponse({ ok: true })
  }
  const session: AppConnection = { ...config, authorization: 'Session abc' }

  await appRequest(session, { method: 'GET', path: '/api/accounts' }, fetchImpl)

  const headers = calls[0]![1]?.headers as Record<string, string>
  expect(headers['Authorization']).toBe('Session abc')
})

test('запрос без тела не отправляет поле body вовсе', async () => {
  const calls: [string, RequestInit | undefined][] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push([String(url), init])
    return jsonResponse([])
  }

  await appRequest(config, { method: 'GET', path: '/api/accounts' }, fetchImpl)

  expect(calls[0]![1]?.body).toBeUndefined()
})

test('успешный ответ отдаётся разобранным JSON', async () => {
  const fetchImpl: FetchImpl = async () => jsonResponse({ id: 'acc-1' }, 201)

  await expect(appRequest(config, { method: 'GET', path: '/api/accounts' }, fetchImpl)).resolves.toEqual({
    id: 'acc-1',
  })
})

test('отказ приложения бросает ошибку с кодом и текстом причины, без значений полей', async () => {
  const fetchImpl: FetchImpl = async () =>
    jsonResponse(
      {
        detail: [
          { loc: ['body', 'balance'], msg: 'Input should be a valid decimal', input: '1234.5' },
        ],
      },
      422,
    )

  const error = await appRequest(config, { method: 'PUT', path: '/api/accounts/discovered' }, fetchImpl).catch(
    (e: unknown) => e,
  )
  const text = String(error)
  expect(text).toContain('422')
  expect(text).toContain('body.balance')
  expect(text).toContain('Input should be a valid decimal')
  expect(text).not.toContain('1234.5')
})

test('отказ приложения — ошибка со статусом полем: по нему различают «сессия кончилась» и отказ по одному счёту', async () => {
  const fetchImpl: FetchImpl = async () => jsonResponse({ detail: 'Сессия недействительна' }, 401)

  const error = await appRequest(config, { method: 'GET', path: '/api/accounts' }, fetchImpl).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(AppHttpError)
  expect((error as AppHttpError).status).toBe(401)
  expect((error as AppHttpError).name).toBe('AppHttpError')
  expect((error as AppHttpError).message).toBe('Приложение ответило 401: Сессия недействительна')
})

test('непонятное тело ответа на отказе даёт только код статуса', async () => {
  const fetchImpl: FetchImpl = async () => new Response('<html>502</html>', { status: 502 })

  await expect(
    appRequest(config, { method: 'GET', path: '/api/accounts' }, fetchImpl),
  ).rejects.toThrow(/^Приложение ответило 502$/)
})
