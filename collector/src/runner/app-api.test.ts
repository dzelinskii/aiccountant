import { expect, test } from 'vitest'
import type { FetchImpl } from '../http/allowlist-client'
import type { CollectorConfig } from './config'
import { appRequest } from './app-api'

const config: CollectorConfig = {
  apiBaseUrl: 'http://app.local',
  apiToken: 'secret-token',
  workspaceId: 'ws-1',
  days: 30,
  bank: 'tbank',
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

test('непонятное тело ответа на отказе даёт только код статуса', async () => {
  const fetchImpl: FetchImpl = async () => new Response('<html>502</html>', { status: 502 })

  await expect(
    appRequest(config, { method: 'GET', path: '/api/accounts' }, fetchImpl),
  ).rejects.toThrow(/^Приложение ответило 502$/)
})
