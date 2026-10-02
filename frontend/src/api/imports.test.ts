import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { rejectImport } from './imports'

const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

test('отклонение — POST в ручку reject своего импорта и workspace', async () => {
  await expect(rejectImport('ws-1', 'imp-1')).resolves.toBeUndefined()

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/imports/imp-1/reject?workspace_id=ws-1')
  expect(init.method).toBe('POST')
})
