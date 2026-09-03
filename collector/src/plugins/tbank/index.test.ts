import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { NotAllowedError, type FetchImpl } from '../../http/allowlist-client'
import { createTBankClient, TBANK_ALLOWED } from './client'
import { checkSession, fetchAccounts, fetchOperations, SessionExpiredError } from './index'

function readFixtureText(name: string): string {
  const path = fileURLToPath(new URL(`../../../tests/fixtures/${name}`, import.meta.url))
  return readFileSync(path, 'utf-8')
}

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

test('fetchAccounts приводит счета к нашей модели', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse(readFixtureText('accounts.json')))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  const accounts = await fetchAccounts(client)

  expect(accounts).toEqual([
    { id: 'acc-1', name: 'Счёт для трат', type: 'Current', currency: 'RUB' },
    { id: 'acc-2', name: 'Накопительный', type: 'Saving', currency: 'RUB' },
  ])
})

test('fetchAccounts бросает, если payload от банка не массив', async () => {
  // тихая подмена не-массива на [] на транспортном уровне неотличима от
  // «банк и правда прислал 0 счетов»
  const fetchImpl = vi.fn(async () => jsonResponse('{"resultCode":"OK","payload":"не массив"}'))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(fetchAccounts(client)).rejects.toThrow(/payload/)
})

test('fetchOperations приводит операции к нашей модели', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse(readFixtureText('operations.json')))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  const operations = await fetchOperations(client, 'acc-1', 1783200000000, 1783700000000)

  expect(operations).toHaveLength(3) // op-1, op-2, op-4 — op-3 FAILED отфильтрован
  expect(operations.map((op) => op.external_id)).toEqual(['op-1', 'op-2', 'op-4'])
})

test('сумма с числом значащих цифр за пределами float не теряет точность через реальный parseLossless', async () => {
  // предыдущая версия этого теста подавала toOperations объект, где value уже
  // строка, минуя parseLossless — тест бил мимо шва, который и должен ловить
  // подмену parseLossless на обычный JSON.parse. Здесь проходит полный путь:
  // фикстура-текст → AllowlistClient → parseLossless → toOperations
  const fetchImpl = vi.fn(async () => jsonResponse(readFixtureText('operations.json')))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  const operations = await fetchOperations(client, 'acc-1', 1783200000000, 1783700000000)

  const precise = operations.find((op) => op.external_id === 'op-4')
  expect(precise?.amount).toBe('123456789012345.6789')
})

test('fetchOperations передаёт account, start и end в запрос', async () => {
  const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(readFixtureText('operations.json')))
  const client = createTBankClient('token', { fetchImpl })

  await fetchOperations(client, 'acc-1', 1783200000000, 1783600000000)

  const url = fetchImpl.mock.calls[0]?.[0] as URL
  expect(url.searchParams.get('account')).toBe('acc-1')
  expect(url.searchParams.get('start')).toBe('1783200000000')
  expect(url.searchParams.get('end')).toBe('1783600000000')
})

test('AUTHENTICATION_FAILED превращается в SessionExpiredError', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse('{"resultCode":"AUTHENTICATION_FAILED"}'))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.toBeInstanceOf(SessionExpiredError)
})

test('SESSION_IS_ABSENT превращается в SessionExpiredError', async () => {
  // именно этот код банк отдаёт на живом прогоне, когда токен уже прочитан,
  // но сессией ещё не стал: лечится повторным входом, а не падением
  const fetchImpl = vi.fn(async () => jsonResponse('{"resultCode":"SESSION_IS_ABSENT"}'))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.toBeInstanceOf(SessionExpiredError)
})

test('иной resultCode даёт обычную ошибку, а не SessionExpiredError', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse('{"resultCode":"UNKNOWN_ERROR"}'))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.not.toBeInstanceOf(SessionExpiredError)
})

test('checkSession принимает живую сессию, когда поля лежат на верхнем уровне', async () => {
  const fetchImpl = vi.fn(
    async () => jsonResponse('{"resultCode":"OK","millisLeft":3600000,"accessLevel":"FULL"}'),
  )
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).resolves.toBeUndefined()
})

test('анонимная сессия не считается живой, хотя ответ успешный', async () => {
  // ровно то, что вернул живой банк через 2,5 часа после истечения сессии:
  // resultCode "OK" и положительный millisLeft — но это счётчик анонимной
  // сессии. Одного millisLeft мало, различает только accessLevel
  const fetchImpl = vi.fn(
    async () =>
      jsonResponse('{"resultCode":"OK","payload":{"accessLevel":"ANONYMOUS","millisLeft":659622}}'),
  )
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.toBeInstanceOf(SessionExpiredError)
})

test('незнакомый уровень доступа живой сессии не мешает', async () => {
  // обратная проверка (равенство "CLIENT") отправила бы человека вводить код
  // по кругу, появись у банка новый уровень доступа
  const fetchImpl = vi.fn(
    async () =>
      jsonResponse('{"resultCode":"OK","payload":{"accessLevel":"PREMIUM","millisLeft":3600000}}'),
  )
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).resolves.toBeUndefined()
})

test('checkSession принимает живую сессию, когда поля лежат в payload', async () => {
  // остальные эндпоинты этого API кладут данные в payload; реального ответа
  // session_status у нас нет, поэтому обе формы конверта равноправны
  const fetchImpl = vi.fn(
    async () => jsonResponse('{"resultCode":"OK","payload":{"millisLeft":3600000,"accessLevel":"FULL"}}'),
  )
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).resolves.toBeUndefined()
})

test('checkSession бросает SessionExpiredError, если millisLeft <= 0 при resultCode OK', async () => {
  // резервный случай: банк отвечает OK на уже протухшую сессию, просто с
  // истёкшим временем жизни — проверка одного resultCode это бы не поймала
  const fetchImpl = vi.fn(
    async () => jsonResponse('{"resultCode":"OK","millisLeft":0,"accessLevel":"FULL"}'),
  )
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.toBeInstanceOf(SessionExpiredError)
})

test('checkSession видит истёкший millisLeft и в payload', async () => {
  const fetchImpl = vi.fn(
    async () => jsonResponse('{"resultCode":"OK","payload":{"millisLeft":-1,"accessLevel":"FULL"}}'),
  )
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.toBeInstanceOf(SessionExpiredError)
})

test('ответ session_status неожиданной формы — обычная ошибка, а не SessionExpiredError', async () => {
  // главное свойство: не найденный millisLeft — это баг нашего разбора, а не
  // истёкшая сессия. SessionExpiredError здесь означал бы бесконечный круг
  // «живая кука → не нашли поле → окно входа → тот же ответ → окно входа»
  const fetchImpl = vi.fn(async () => jsonResponse('{"resultCode":"OK","payload":{"status":"ACTIVE"}}'))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.toThrow(Error)
  await expect(checkSession(client)).rejects.not.toBeInstanceOf(SessionExpiredError)
})

test('нечисловой millisLeft — обычная ошибка, а не SessionExpiredError', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse('{"resultCode":"OK","millisLeft":"скоро"}'))
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(checkSession(client)).rejects.not.toBeInstanceOf(SessionExpiredError)
})

test('клиент отказывается ходить по неразрешённому пути — allowlist реально ограничивает', async () => {
  const fetchImpl = vi.fn()
  const client = createTBankClient('token', { fetchImpl: fetchImpl as unknown as FetchImpl })

  await expect(client.getJson('/api/common/v1/transfer')).rejects.toBeInstanceOf(NotAllowedError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('TBANK_ALLOWED содержит ровно пять задокументированных путей', () => {
  expect(TBANK_ALLOWED).toEqual([
    '/api/common/v1/accounts_light_ib',
    '/api/common/v1/session_status',
    '/mybank/api/operations/timeline/public/legacy/v1/operations',
    '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank',
    '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user',
  ])
})
