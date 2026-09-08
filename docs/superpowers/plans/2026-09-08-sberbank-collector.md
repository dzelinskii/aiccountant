# Коллектор Сбербанка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Научить коллектор забирать операции из Сбербанка наравне с Т-Банком, введя при этом реестр плагинов, хранилище секрета и якорь доверия к УЦ Минцифры.

**Architecture:** Ядро — плагины банков за общим интерфейсом `BankPlugin`; оболочка (`runner`) знает про конфиг, хранилище секрета, сертификат и отправку в приложение, но не знает про устройство секрета конкретного банка. Транспорт вынесен за интерфейс, чтобы Сбербанк мог ходить по HTTPS со своим корневым сертификатом, а Т-Банк остался на `fetch`.

**Tech Stack:** TypeScript, Node 22+, pnpm, vitest, Playwright, `@napi-rs/keyring`.

**Спека:** `docs/superpowers/specs/2026-09-08-sberbank-collector-design.md`
**Разведка (форматы и образцы):** `docs/superpowers/specs/2026-09-08-sberbank-api-recon.md`

---

## Структура файлов

Создаётся:

| Файл | Ответственность |
|---|---|
| `collector/src/http/transport.ts` | узкий интерфейс транспорта и две реализации: на `fetch` и на `node:https` со своим корнем |
| `collector/src/core/contract.ts` | общие типы: `CollectedOperation`, `CollectedAccount`, `Credentials`, `LoginPrompt`, `BankPlugin` |
| `collector/src/plugins/registry.ts` | реестр «имя банка → плагин» |
| `collector/src/runner/secret-store.ts` | хранение секрета в средствах ОС |
| `collector/src/runner/trust-anchor.ts` | получение и проверка корня УЦ Минцифры по зашитому отпечатку |
| `collector/src/plugins/sber/types.ts` | типы ответов Сбербанка |
| `collector/src/plugins/sber/client.ts` | адреса, allowlist, сборка клиента |
| `collector/src/plugins/sber/map.ts` | отображение ответов банка в нашу модель |
| `collector/src/plugins/sber/login.ts` | окно входа и добыча кук |
| `collector/src/plugins/sber/index.ts` | реализация `BankPlugin` для Сбербанка |

Изменяется:

| Файл | Что меняется |
|---|---|
| `collector/src/http/allowlist-client.ts` | метод на эндпоинт, предъявление секрета описанием, транспорт снаружи |
| `collector/src/plugins/tbank/types.ts` | типы модели уезжают в `contract.ts`, остаётся реэкспорт |
| `collector/src/plugins/tbank/client.ts` | новая форма allowlist и credentials |
| `collector/src/plugins/tbank/index.ts` | обёртка в объект `BankPlugin` |
| `collector/src/runner/main.ts` | выбор банка через реестр, сессия из хранилища |
| `collector/src/runner/session.ts` | из общей оболочки уезжает всё, что знает про Т-Банк |
| `collector/src/runner/push.ts` | имя парсера берётся у плагина |
| `collector/src/runner/config.ts` | выбор банка, пер-банковский конфиг счетов |
| `collector/src/runner/forget.ts` | забывает и профиль, и запись в хранилище |
| `collector/README.md` | два банка, честная формулировка про allowlist |

---

## Task 1: Транспорт и клиент с методом на эндпоинт

**Зачем.** Сбербанк отдаёт данные по `POST` и авторизует кукой, а нынешний клиент умеет только `GET` с токеном в query. Плюс Node `fetch` не принимает свой корневой сертификат, а Сбербанку он нужен — значит транспорт должен быть заменяемым.

**Files:**
- Create: `collector/src/http/transport.ts`
- Create: `collector/src/http/transport.test.ts`
- Modify: `collector/src/http/allowlist-client.ts`
- Modify: `collector/src/http/allowlist-client.test.ts`

- [ ] **Step 1: Написать падающий тест на транспорт и метод**

Создать `collector/src/http/transport.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { fetchTransport } from './transport'

test('транспорт на fetch передаёт метод, заголовки и тело', async () => {
  const seen: { method?: string; headers?: Record<string, string>; body?: string } = {}
  const fake: typeof fetch = async (url, init) => {
    seen.method = init?.method
    seen.headers = init?.headers as Record<string, string>
    seen.body = init?.body as string
    return new Response('{"ok":true}', { status: 200 })
  }

  const transport = fetchTransport(fake)
  const res = await transport.send(new URL('https://example.test/api'), {
    method: 'POST',
    headers: { Cookie: 'a=1' },
    body: '{"x":1}',
    signal: AbortSignal.timeout(1000),
  })

  expect(seen.method).toBe('POST')
  expect(seen.headers).toEqual({ Cookie: 'a=1' })
  expect(seen.body).toBe('{"x":1}')
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('{"ok":true}')
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd collector && pnpm vitest run src/http/transport.test.ts`
Expected: FAIL — `Failed to resolve import "./transport"`

- [ ] **Step 3: Реализовать транспорт**

Создать `collector/src/http/transport.ts`:

```typescript
import { request as httpsRequest } from 'node:https'

export interface HttpResponse {
  readonly status: number
  readonly ok: boolean
  text(): Promise<string>
}

export interface SendOptions {
  readonly method: 'GET' | 'POST'
  readonly headers: Record<string, string>
  readonly body?: string
  readonly signal: AbortSignal
}

/**
 * Узкий транспорт вместо голого fetch: Сбербанку нужен свой корневой
 * сертификат, а fetch в Node принять его не умеет — только node:https. Клиенту
 * при этом всё равно, кто именно доставляет запрос.
 */
export interface Transport {
  send(url: URL, options: SendOptions): Promise<HttpResponse>
}

export function fetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return {
    async send(url, { method, headers, body, signal }) {
      const res = await fetchImpl(url, {
        method,
        headers,
        body,
        // без этого fetch молча следует за Location, в том числе на чужой
        // origin — allowlist проверяется один раз, до запроса, и редирект его
        // обходит
        redirect: 'error',
        signal,
      })
      return { status: res.status, ok: res.ok, text: () => res.text() }
    },
  }
}

/**
 * Транспорт с явным якорем доверия: переданный корень ЗАМЕНЯЕТ системный набор,
 * а не дополняет его. Для банка, чей УЦ в системе отсутствует, это одновременно
 * и единственный способ соединиться, и проверка строже системной.
 */
export function httpsTransport(ca: string): Transport {
  return {
    send(url, { method, headers, body, signal }) {
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          url,
          {
            method,
            ca,
            headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
          },
          (res) => {
            const status = res.statusCode ?? 0
            let text = ''
            res.setEncoding('utf-8')
            res.on('data', (chunk: string) => {
              text += chunk
            })
            res.on('end', () => {
              resolve({ status, ok: status >= 200 && status < 300, text: async () => text })
            })
          },
        )
        // редирект node:https сам не проходит, но и ошибкой не считает —
        // проверяем статус на стороне клиента (см. allowlist-client)
        req.on('error', reject)
        signal.addEventListener('abort', () => req.destroy(new Error('Таймаут запроса')), { once: true })
        if (body !== undefined) req.write(body)
        req.end()
      })
    },
  }
}
```

- [ ] **Step 4: Прогнать тест транспорта**

Run: `cd collector && pnpm vitest run src/http/transport.test.ts`
Expected: PASS

- [ ] **Step 5: Написать падающий тест на клиент**

Дополнить `collector/src/http/allowlist-client.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { AllowlistClient, NotAllowedError } from './allowlist-client'
import type { Transport } from './transport'

function recordingTransport(body = '{"ok":true}'): { transport: Transport; calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] } {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const transport: Transport = {
    async send(url, options) {
      calls.push({ url: url.toString(), method: options.method, headers: options.headers, body: options.body })
      return { status: 200, ok: true, text: async () => body }
    },
  }
  return { transport, calls }
}

test('секрет-заголовок уходит в заголовках, а не в адресе', async () => {
  const { transport, calls } = recordingTransport()
  const client = new AllowlistClient({
    baseUrl: 'https://bank.test',
    allowed: [{ path: '/data', method: 'POST' }],
    credentials: { kind: 'header', name: 'Cookie', value: 'SESSION=secret' },
    transport,
  })

  await client.postJson('/data', { page: 1 })

  expect(calls[0]?.headers['Cookie']).toBe('SESSION=secret')
  expect(calls[0]?.url).not.toContain('secret')
  expect(calls[0]?.body).toBe('{"page":1}')
})

test('POST по пути, разрешённому только для GET, не отправляется', async () => {
  const { transport, calls } = recordingTransport()
  const client = new AllowlistClient({
    baseUrl: 'https://bank.test',
    allowed: [{ path: '/data', method: 'GET' }],
    credentials: { kind: 'header', name: 'Cookie', value: 'SESSION=secret' },
    transport,
  })

  await expect(client.postJson('/data', {})).rejects.toBeInstanceOf(NotAllowedError)
  expect(calls).toHaveLength(0)
})
```

- [ ] **Step 6: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/http/allowlist-client.test.ts`
Expected: FAIL — у `AllowlistClient` нет `postJson`, конструктор не принимает `allowed`/`credentials`/`transport`

- [ ] **Step 7: Переписать клиент**

Заменить содержимое `collector/src/http/allowlist-client.ts` (вспомогательные `describeCause`, `hasProp`, `hasStringProp` из текущего файла сохранить как есть, ниже показана изменяемая часть):

```typescript
import { parseLossless } from './lossless-json'
import type { Transport } from './transport'
import { fetchTransport } from './transport'

export class NotAllowedError extends Error {}

/**
 * Банк ответил, но не успехом. Статус вынесен в поле, а не оставлен в тексте:
 * протухшую сессию (403) от сетевого сбоя приходится отличать в коде, и разбор
 * сообщения строкой был бы швом, который молча сломается при первой же правке
 * текста ошибки.
 */
export class BankHttpError extends Error {
  constructor(readonly status: number) {
    super(`Банк ответил ${status}`)
  }
}

export type FetchImpl = typeof fetch

/**
 * Как предъявляется секрет банку. Для раннера это непрозрачное значение: он
 * его хранит и передаёт, но не толкует — у Т-Банка это токен в query, у
 * Сбербанка заголовок с куками, и оболочка про разницу знать не должна.
 */
export type Credentials =
  | { readonly kind: 'query'; readonly name: string; readonly value: string }
  | { readonly kind: 'header'; readonly name: string; readonly value: string }

export interface AllowedEndpoint {
  readonly path: string
  readonly method: 'GET' | 'POST'
}

interface Options {
  baseUrl: string
  allowed: readonly AllowedEndpoint[]
  credentials: Credentials
  transport?: Transport
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * HTTP-клиент, который физически не способен на лишнее: только перечисленные
 * адреса, только разрешённым для каждого методом, без следования за
 * редиректами. Проверяемое ограничение вместо обещания.
 *
 * Оговорка про Сбербанк: там чтение идёт через POST, поэтому метод сам по себе
 * безвредности больше не доказывает — гарантией остаётся сам список адресов.
 */
export class AllowlistClient {
  private readonly baseUrl: string
  private readonly allowed: readonly AllowedEndpoint[]
  private readonly credentials: Credentials
  private readonly transport: Transport
  private readonly timeoutMs: number

  constructor({ baseUrl, allowed, credentials, transport = fetchTransport(), timeoutMs = DEFAULT_TIMEOUT_MS }: Options) {
    this.baseUrl = baseUrl
    this.allowed = allowed
    this.credentials = credentials
    this.transport = transport
    this.timeoutMs = timeoutMs
  }

  async getJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = this.buildUrl(path, 'GET', params)
    return this.send(url, 'GET', undefined, path)
  }

  async postJson(path: string, body: unknown): Promise<unknown> {
    const url = this.buildUrl(path, 'POST', {})
    return this.send(url, 'POST', JSON.stringify(body), path)
  }

  private buildUrl(path: string, method: 'GET' | 'POST', params: Record<string, string>): URL {
    if (!this.allowed.some((endpoint) => endpoint.path === path && endpoint.method === method)) {
      // в сообщение кладём только путь и метод: ни секрета, ни параметров
      throw new NotAllowedError(`Не разрешено: ${method} ${path}`)
    }
    const url = new URL(path, this.baseUrl)
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new NotAllowedError('Чужой origin')
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    if (this.credentials.kind === 'query') {
      url.searchParams.set(this.credentials.name, this.credentials.value)
    }
    return url
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.credentials.kind === 'header') {
      headers[this.credentials.name] = this.credentials.value
    }
    return headers
  }

  private async send(url: URL, method: 'GET' | 'POST', body: string | undefined, path: string): Promise<unknown> {
    const headers = this.headers()
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const text = await this.fetchText(url, method, headers, body)
    try {
      return parseLossless(text)
    } catch {
      // тело ответа не пробрасываем: там операции и суммы. Частый источник
      // таких сбоев — протухшая сессия, банк тогда отдаёт HTML вместо JSON
      throw new Error(`Банк вернул не JSON на ${path} (${text.length} байт)`)
    }
  }

  // AbortController + setTimeout, снятый в finally, живут ровно до конца
  // запроса: таймер держит контроллер сильной ссылкой, в отличие от
  // AbortSignal.timeout(), чей таймер собирается GC до чтения тела
  private async fetchText(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body: string | undefined): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.transport.send(url, { method, headers, body, signal: controller.signal })
      if (!res.ok) throw new BankHttpError(res.status)
      return await res.text()
    } catch (e) {
      if (e instanceof BankHttpError) throw e
      // транспорт может положить URL (а в нём — секрет в query) в текст своей
      // ошибки, поэтому исходную ошибку как есть не пробрасываем
      throw new Error(`Не удалось получить ответ банка${describeCause(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
```

- [ ] **Step 8: Починить Т-Банк под новую форму клиента**

В `collector/src/plugins/tbank/client.ts` заменить создание клиента:

```typescript
import { AllowlistClient } from '../../http/allowlist-client'
import type { AllowedEndpoint } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'

export const TBANK_BASE = 'https://www.tbank.ru'

// Ровно пять адресов — весь набор возможностей коллектора виден списком
export const TBANK_ALLOWED: readonly AllowedEndpoint[] = [
  { path: '/api/common/v1/accounts_light_ib', method: 'GET' },
  { path: '/api/common/v1/session_status', method: 'GET' },
  { path: '/mybank/api/operations/timeline/public/legacy/v1/operations', method: 'GET' },
  { path: '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_bank', method: 'GET' },
  { path: '/mybank/api/operations/timeline/public/legacy/v1/operations_category_list_user', method: 'GET' },
]

export const COMMON_PARAMS = {
  appName: 'supreme',
  appVersion: '0.0.1',
  origin: 'web,ib5,platform',
  platform: 'web',
} as const

interface CreateOptions {
  transport?: Transport
  timeoutMs?: number
}

export function createTBankClient(token: string, options: CreateOptions = {}): AllowlistClient {
  return new AllowlistClient({
    baseUrl: TBANK_BASE,
    allowed: TBANK_ALLOWED,
    credentials: { kind: 'query', name: 'sessionid', value: token },
    ...options,
  })
}
```

- [ ] **Step 9: Прогнать все тесты коллектора**

Run: `cd collector && pnpm test && pnpm lint && pnpm build`
Expected: все тесты зелёные, линт и типы чистые. Тесты Т-Банка правятся только в местах создания клиента и подмены транспорта — если правится логика, значит рефакторинг что-то сломал.

- [ ] **Step 10: Коммит**

```bash
git add collector/src/http collector/src/plugins/tbank/client.ts collector/src/plugins/tbank
git commit -m "Клиент коллектора: метод на эндпоинт, секрет описанием, сменный транспорт"
```

---

## Task 2: Контракт плагина и реестр

**Зачем.** Сегодня «плагин» — только каталог: раннер импортирует Т-Банк напрямую. Интерфейс нужен до того, как появится второй банк, иначе второй банк будет написан под текущую форму раннера.

**Files:**
- Create: `collector/src/core/contract.ts`
- Create: `collector/src/plugins/registry.ts`
- Create: `collector/src/plugins/registry.test.ts`
- Modify: `collector/src/plugins/tbank/types.ts`
- Modify: `collector/src/plugins/tbank/index.ts`

- [ ] **Step 1: Написать падающий тест реестра**

Создать `collector/src/plugins/registry.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { BANK_NAMES, pluginFor } from './registry'

test('плагин находится по имени банка', () => {
  const plugin = pluginFor('tbank')
  expect(plugin.name).toBe('tbank')
  expect(typeof plugin.fetchOperations).toBe('function')
})

test('незнакомое имя банка — понятная ошибка со списком известных', () => {
  expect(() => pluginFor('unknown-bank')).toThrowError(/unknown-bank/)
  expect(() => pluginFor('unknown-bank')).toThrowError(/tbank/)
})

test('имя плагина совпадает с ключом реестра', () => {
  for (const name of BANK_NAMES) {
    expect(pluginFor(name).name).toBe(name)
  }
})
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/plugins/registry.test.ts`
Expected: FAIL — `Failed to resolve import "./registry"`

- [ ] **Step 3: Написать контракт**

Создать `collector/src/core/contract.ts`:

```typescript
export type { Credentials } from '../http/allowlist-client'
import type { Credentials } from '../http/allowlist-client'

/** Операция в том виде, в каком её принимает наше приложение. */
export interface CollectedOperation {
  occurred_at: string
  amount: string
  currency: string
  description: string
  external_id: string
  /** Вид операции в словаре приложения; словарь банка переводится в плагине. */
  kind: string
  /** Подсказка о категории в словаре приложения; null — банк не подсказал. */
  category_hint: string | null
}

export interface CollectedAccount {
  id: string
  name: string
  type: string
  /** null — валюту распознать не удалось; на сбор по другим счетам не влияет. */
  currency: string | null
  /** Остаток строкой, как отдал банк; null — банк остатка не сообщил. */
  balance: string | null
  /** Последние четыре символа номеров карт; пусто, если карт нет. */
  cardMasks: string[]
}

/**
 * Окно браузера глазами плагина. Плагин не знает ни про Playwright, ни про то,
 * какой браузер открыт: ему нужно привести человека на страницу входа и забрать
 * оттуда секрет. Это же место подменяется, когда вход станет безлюдным.
 */
export interface BrowserSession {
  goto(url: string): Promise<void>
  clearCookie(name: string): Promise<void>
  cookies(url: string): Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>>
  waitForUrl(match: (url: URL) => boolean, timeoutMs: number): Promise<void>
  waitForRequest(match: (url: URL) => boolean, timeoutMs: number): Promise<void>
}

export interface LoginPrompt {
  /**
   * `headless: true` — окно не показывается. Это не оптимизация: у Т-Банка
   * обновление токена идёт молча, и только настоящий вход открывает видимое
   * окно, куда человек вводит код. Без этого различия обычный сбор по живой
   * сессии распахивал бы браузер при каждом запуске.
   */
  withBrowser<T>(use: (session: BrowserSession) => Promise<T>, options?: { headless?: boolean }): Promise<T>
}

/**
 * Всё, что оболочка обязана уметь спросить у банка. Секрет для неё непрозрачен:
 * она его хранит и передаёт обратно, но не толкует.
 */
export interface BankPlugin {
  /** Имя банка; оно же уезжает в поле parser при отправке импорта. */
  readonly name: string
  login(prompt: LoginPrompt): Promise<Credentials>
  isAlive(credentials: Credentials): Promise<boolean>
  fetchAccounts(credentials: Credentials): Promise<CollectedAccount[]>
  /** since/until — epoch-миллисекунды; в формат банка переводит плагин. */
  fetchOperations(
    credentials: Credentials,
    accountId: string,
    since: number,
    until: number,
  ): Promise<CollectedOperation[]>
}
```

- [ ] **Step 4: Сделать типы Т-Банка реэкспортом**

Заменить содержимое `collector/src/plugins/tbank/types.ts`:

```typescript
// Модель переехала в общий контракт: она одна на все банки. Файл оставлен
// реэкспортом, чтобы не переписывать импорты внутри плагина.
export type { CollectedAccount, CollectedOperation } from '../../core/contract'
```

- [ ] **Step 5: Обернуть Т-Банк в объект-плагин**

Дописать в конец `collector/src/plugins/tbank/index.ts`:

```typescript
import type { BankPlugin, Credentials, LoginPrompt } from '../../core/contract'
import { createTBankClient } from './client'
import { obtainTBankToken } from './login'

// Существующие функции остаются как есть — плагин собирается из них, а не
// переписывает их: так видно, что интерфейс лёг на готовый код, а не наоборот
export const tbankPlugin: BankPlugin = {
  name: 'tbank',

  async login(prompt: LoginPrompt): Promise<Credentials> {
    const token = await obtainTBankToken(prompt)
    return { kind: 'query', name: 'sessionid', value: token }
  },

  async isAlive(credentials: Credentials): Promise<boolean> {
    try {
      await checkSession(clientFor(credentials))
      return true
    } catch (error) {
      if (error instanceof SessionExpiredError) return false
      throw error
    }
  },

  fetchAccounts(credentials: Credentials) {
    return fetchAccounts(clientFor(credentials))
  },

  fetchOperations(credentials: Credentials, accountId: string, since: number, until: number) {
    return fetchOperations(clientFor(credentials), accountId, since, until)
  },
}

function clientFor(credentials: Credentials) {
  if (credentials.kind !== 'query') {
    throw new Error('Т-Банк ожидает секрет в query — сохранённая запись не той формы')
  }
  return createTBankClient(credentials.value)
}
```

- [ ] **Step 6: Перенести добычу токена Т-Банка из раннера в плагин**

Создать `collector/src/plugins/tbank/login.ts`, перенеся туда логику из `collector/src/runner/session.ts` (`refreshToken`, `logIn`, `waitForAuthorizedRequest`, `readToken`) и переписав её на `BrowserSession` вместо Playwright напрямую:

```typescript
import type { BrowserSession, LoginPrompt } from '../../core/contract'

const BANK_ORIGIN = 'https://www.tbank.ru'
const LOGIN_URL = `${BANK_ORIGIN}/login/`
const MYBANK_URL = `${BANK_ORIGIN}/mybank/`
const SESSION_COOKIE = 'psid'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const AUTHORIZED_REQUEST_TIMEOUT_MS = 60_000
const REFRESH_TIMEOUT_MS = 20_000

// session_status кабинет дёргает и когда сессии нет — доказательством
// авторизации служит запрос, несущий sessionid
const SESSION_PROBE_PATH = '/api/common/v1/session_status'

function isAuthorized(url: URL): boolean {
  if (url.pathname === SESSION_PROBE_PATH) return false
  const sessionid = url.searchParams.get('sessionid')
  return sessionid !== null && sessionid.length > 0
}

/**
 * psid короткоживущая и ротируется, поэтому в остывшем профиле почти всегда
 * лежит негодное значение. Долго живёт сама сессия: открываем ЛК, и банк по
 * живой сессии выдаёт свежую куку.
 */
export async function obtainTBankToken(prompt: LoginPrompt): Promise<string> {
  return prompt.withBrowser(async (session) => {
    const refreshed = await refresh(session)
    if (refreshed) return refreshed
    return logIn(session)
  })
}

async function refresh(session: BrowserSession): Promise<string | null> {
  await session.goto(MYBANK_URL)
  try {
    await session.waitForRequest(isAuthorized, REFRESH_TIMEOUT_MS)
  } catch {
    return null
  }
  return readToken(session)
}

async function logIn(session: BrowserSession): Promise<string> {
  // с протухшей кукой банк уводит со страницы входа обратно в ЛК, и мы бы
  // прочитали ровно тот же мёртвый токен
  await session.clearCookie(SESSION_COOKIE)
  await session.goto(LOGIN_URL)
  await session.waitForUrl((url) => url.href.startsWith(MYBANK_URL), LOGIN_TIMEOUT_MS)
  await session.waitForRequest(isAuthorized, AUTHORIZED_REQUEST_TIMEOUT_MS)
  const token = await readToken(session)
  if (!token) throw new Error(`Вход выполнен, но банк не оставил куку ${SESSION_COOKIE} — сессии нет`)
  return token
}

async function readToken(session: BrowserSession): Promise<string | null> {
  const cookies = await session.cookies(BANK_ORIGIN)
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? null
}
```

- [ ] **Step 7: Написать реестр**

Создать `collector/src/plugins/registry.ts`:

```typescript
import type { BankPlugin } from '../core/contract'
import { tbankPlugin } from './tbank'

// Реестр намеренно плоский и явный: список банков виден целиком, без
// автозагрузки каталогов и магии по именам файлов
const PLUGINS: Record<string, BankPlugin> = {
  [tbankPlugin.name]: tbankPlugin,
}

export const BANK_NAMES: readonly string[] = Object.keys(PLUGINS)

export function pluginFor(name: string): BankPlugin {
  const plugin = PLUGINS[name]
  if (!plugin) {
    throw new Error(`Неизвестный банк "${name}". Известные: ${BANK_NAMES.join(', ')}`)
  }
  return plugin
}
```

- [ ] **Step 8: Прогнать тесты реестра**

Run: `cd collector && pnpm vitest run src/plugins/registry.test.ts`
Expected: PASS (три теста)

- [ ] **Step 9: Прогнать всё**

Run: `cd collector && pnpm test && pnpm lint && pnpm build`
Expected: зелено. `runner/session.ts` пока остаётся на месте — он переписывается в Task 8.

- [ ] **Step 10: Коммит**

```bash
git add collector/src/plugins
git commit -m "Реестр плагинов банков и общий контракт; Т-Банк переехал на интерфейс"
```

---

## Task 3: Хранилище секрета

**Зачем.** Куки Сбербанка сессионные, профиль браузера их не сохраняет — проверено разведкой. Без своего хранилища каждый сбор требовал бы полного входа.

**Files:**
- Create: `collector/src/runner/secret-store.ts`
- Create: `collector/src/runner/secret-store.test.ts`
- Modify: `collector/package.json`

- [ ] **Step 1: Поставить зависимость**

```bash
cd collector && pnpm add @napi-rs/keyring
```

- [ ] **Step 2: Написать падающий тест**

Создать `collector/src/runner/secret-store.test.ts`:

```typescript
import { expect, test } from 'vitest'
import type { Credentials } from '../core/contract'
import { memorySecretStore, parseCredentials, serializeCredentials } from './secret-store'

const HEADER_CREDENTIALS: Credentials = { kind: 'header', name: 'Cookie', value: 'UFS-SESSION=a; UFS-TOKEN=b' }

test('секрет переживает сериализацию без искажений', () => {
  expect(parseCredentials(serializeCredentials(HEADER_CREDENTIALS))).toEqual(HEADER_CREDENTIALS)
})

test('мусор вместо записи читается как отсутствие секрета, а не падает', () => {
  expect(parseCredentials('не json')).toBeNull()
  expect(parseCredentials('{"kind":"telepathy","name":"x","value":"y"}')).toBeNull()
})

test('хранилище отдаёт записанное и забывает стёртое', async () => {
  const store = memorySecretStore()
  expect(await store.read('sber')).toBeNull()

  await store.write('sber', HEADER_CREDENTIALS)
  expect(await store.read('sber')).toEqual(HEADER_CREDENTIALS)

  await store.clear('sber')
  expect(await store.read('sber')).toBeNull()
})

test('банки не видят секретов друг друга', async () => {
  const store = memorySecretStore()
  await store.write('sber', HEADER_CREDENTIALS)
  expect(await store.read('tbank')).toBeNull()
})
```

- [ ] **Step 3: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/runner/secret-store.test.ts`
Expected: FAIL — `Failed to resolve import "./secret-store"`

- [ ] **Step 4: Реализовать хранилище**

Создать `collector/src/runner/secret-store.ts`:

```typescript
import { Entry } from '@napi-rs/keyring'
import type { Credentials } from '../core/contract'

const SERVICE = 'aiccountant-collector'

export interface SecretStore {
  read(bank: string): Promise<Credentials | null>
  write(bank: string, credentials: Credentials): Promise<void>
  clear(bank: string): Promise<void>
}

export function serializeCredentials(credentials: Credentials): string {
  return JSON.stringify(credentials)
}

/**
 * Непригодная запись — это не сбой, а «секрета нет»: в хранилище могла остаться
 * запись от прежней версии формата. Падать здесь значило бы требовать от
 * человека руками чистить keychain вместо обычного повторного входа.
 */
export function parseCredentials(raw: string): Credentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { kind, name, value } = parsed as Record<string, unknown>
  if (kind !== 'query' && kind !== 'header') return null
  if (typeof name !== 'string' || name === '' || typeof value !== 'string' || value === '') return null
  return { kind, name, value }
}

/**
 * Секрет живёт в средствах ОС: Credential Manager, Keychain или libsecret.
 * В файлы, переменные окружения и git он не попадает никогда.
 */
export function osSecretStore(): SecretStore {
  const entry = (bank: string): Entry => new Entry(SERVICE, bank)
  return {
    async read(bank) {
      try {
        const raw = entry(bank).getPassword()
        return raw ? parseCredentials(raw) : null
      } catch {
        // библиотека бросает, когда записи нет — для нас это обычное «нет»
        return null
      }
    },
    async write(bank, credentials) {
      entry(bank).setPassword(serializeCredentials(credentials))
    },
    async clear(bank) {
      try {
        entry(bank).deletePassword()
      } catch {
        // стереть отсутствующее — не ошибка: «забыть доступ» должно работать
        // и до первого входа, и повторно
      }
    },
  }
}

/** Для тестов и для случая, когда хранить секрет между запусками не нужно. */
export function memorySecretStore(): SecretStore {
  const kept = new Map<string, Credentials>()
  return {
    async read(bank) {
      return kept.get(bank) ?? null
    },
    async write(bank, credentials) {
      kept.set(bank, credentials)
    },
    async clear(bank) {
      kept.delete(bank)
    },
  }
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd collector && pnpm vitest run src/runner/secret-store.test.ts`
Expected: PASS (четыре теста)

- [ ] **Step 6: Проверить реальное хранилище ОС руками**

Разовая проверка, что нативный модуль работает на этой машине (в автотесты не идёт — она трогает настоящий keychain пользователя):

```bash
cd collector && node --input-type=module -e "
import { osSecretStore } from './src/runner/secret-store.ts'
const store = osSecretStore()
await store.write('probe', { kind: 'header', name: 'Cookie', value: 'x=1' })
console.log('прочитано:', await store.read('probe'))
await store.clear('probe')
console.log('после стирания:', await store.read('probe'))
"
```

Expected: `прочитано: { kind: 'header', name: 'Cookie', value: 'x=1' }`, затем `после стирания: null`.
Если модуль не собрался под платформу — остановиться и разобраться здесь, а не на этапе входа в банк.

- [ ] **Step 7: Коммит**

```bash
git add collector/package.json collector/pnpm-lock.yaml collector/src/runner/secret-store.ts collector/src/runner/secret-store.test.ts
git commit -m "Хранилище секрета банка поверх средств ОС"
```

---

## Task 4: Якорь доверия к УЦ Минцифры

**Зачем.** Сбербанк выпущен УЦ, которого нет ни в хранилище ОС, ни в Node. Без корня не работает ни окно входа, ни сбор. Скачивать его можно, доверять скачанному на слово — нет.

**Files:**
- Create: `collector/src/runner/trust-anchor.ts`
- Create: `collector/src/runner/trust-anchor.test.ts`
- Create: `collector/tests/fixtures/russian_trusted_root_ca.pem`

- [ ] **Step 1: Положить настоящий корень в фикстуры**

```bash
cd collector && curl -sS -o tests/fixtures/russian_trusted_root_ca.pem https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
openssl x509 -in tests/fixtures/russian_trusted_root_ca.pem -noout -fingerprint -sha256
```

Expected: `SHA256 Fingerprint=D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`

Если отпечаток другой — **остановиться**. Это не повод «обновить константу»: либо раздача подменена, либо УЦ сменил корень, и то и другое требует решения человека.

- [ ] **Step 2: Написать падающий тест**

Создать `collector/src/runner/trust-anchor.test.ts`:

```typescript
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { ROOT_SHA256, ROOT_SPKI_SHA256, certificateFingerprint, verifyCertificate } from './trust-anchor'

function realPem(): string {
  return readFileSync(fileURLToPath(new URL('../../tests/fixtures/russian_trusted_root_ca.pem', import.meta.url)), 'utf-8')
}

test('настоящий корень совпадает с зашитым отпечатком', () => {
  expect(certificateFingerprint(realPem())).toBe(ROOT_SHA256)
  expect(() => verifyCertificate(realPem())).not.toThrow()
})

test('подменённый сертификат отвергается, а не используется', () => {
  const tampered = realPem().replace(/^([A-Za-z0-9+/]{20})/m, 'AAAAAAAAAAAAAAAAAAAA')
  expect(() => verifyCertificate(tampered)).toThrowError(/отпечат/i)
})

test('не-сертификат отвергается понятной ошибкой', () => {
  expect(() => verifyCertificate('это не сертификат')).toThrowError(/сертификат/i)
})

test('отпечаток открытого ключа для закрепления в браузере зафиксирован', () => {
  expect(ROOT_SPKI_SHA256).toBe('ArgiDAcHKNt3HZrFnlRSHE7drSGng7smz98ZwdsPrjc=')
})
```

- [ ] **Step 3: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/runner/trust-anchor.test.ts`
Expected: FAIL — `Failed to resolve import "./trust-anchor"`

- [ ] **Step 4: Реализовать якорь**

Создать `collector/src/runner/trust-anchor.ts`:

```typescript
import { createHash, createPublicKey } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
// загрузка живёт в src/http, где сетевой доступ разрешён правилом линтера:
// заводить ради неё второе исключение значило бы разменять проверяемость
// allowlist на удобство одного модуля
import { fetchPublicText } from '../http/download'

/**
 * Отпечаток корня УЦ Минцифры зашит в код намеренно. Скачивание — удобство;
 * доверие держится на этой константе, которую видно при ревью. Файл, не
 * совпавший с ней, отвергается, а не используется «раз уж скачали».
 */
export const ROOT_SHA256 = 'd26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31'

/** Отпечаток открытого ключа — им браузер закрепляет ровно этот УЦ. */
export const ROOT_SPKI_SHA256 = 'ArgiDAcHKNt3HZrFnlRSHE7drSGng7smz98ZwdsPrjc='

const ROOT_URL = 'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt'
const PEM_BODY = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/
const PEM_HEADER = /-----BEGIN CERTIFICATE-----/g

/**
 * Байты сертификата, и только они. Файл с более чем одним блоком отвергается,
 * а не разбирается по первому: `node:https` принимает склеенные PEM-блоки как
 * НЕСКОЛЬКО доверенных корней сразу. Проверить отпечаток первого блока и
 * отдать наружу всю строку означало бы сделать доверенным и всё, что к ней
 * приписано, — то есть обойти весь смысл этого модуля, не подделав ни байта в
 * настоящем сертификате.
 */
function certificateDer(pem: string): Buffer {
  const blocks = pem.match(PEM_HEADER)?.length ?? 0
  if (blocks > 1) {
    throw new Error(`Ожидался один сертификат, в файле их ${blocks} — лишние блоки доверия не получат`)
  }
  const match = PEM_BODY.exec(pem)
  if (!match?.[1]) throw new Error('Это не PEM-сертификат')
  return Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
}

export function certificateFingerprint(pem: string): string {
  return createHash('sha256').update(certificateDer(pem)).digest('hex')
}

/** Отпечаток открытого ключа — им браузер закрепляет ровно этот УЦ. */
export function spkiFingerprint(pem: string): string {
  const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('base64')
}

/**
 * Возвращает канонически пересобранный PEM: наружу уходят только проверенные
 * байты, что бы ни лежало в исходном файле рядом с ними.
 */
export function verifyCertificate(pem: string): string {
  const der = certificateDer(pem)
  const actual = createHash('sha256').update(der).digest('hex')
  if (actual !== ROOT_SHA256) {
    // значения отпечатков в сообщении нужны: по ним сразу видно, подменённый
    // это файл или УЦ действительно сменил корень
    throw new Error(`Отпечаток корневого сертификата не совпал: ожидали ${ROOT_SHA256}, получили ${actual}`)
  }
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

/**
 * Порядок: кеш → скачивание → проверка. Сети нет и кеша нет — падаем понятно,
 * а не идём в банк без проверки сертификата.
 */
export async function loadTrustAnchor(
  cachePath: string,
  download: (url: string) => Promise<string> = fetchPublicText,
): Promise<string> {
  const cached = await readFile(cachePath, 'utf-8').catch(() => null)
  if (cached) {
    try {
      return verifyCertificate(cached)
    } catch (error) {
      // без пути человек не поймёт, что речь о файле на диске, и не догадается,
      // что чинится это удалением кеша, а не переустановкой чего-либо
      throw new Error(`Сертификат в кеше ${cachePath} не прошёл проверку: ${String(error)}. Удалите файл и запустите снова`)
    }
  }

  let downloaded: string
  try {
    downloaded = await download(ROOT_URL)
  } catch (error) {
    throw new Error(
      `Не удалось получить корневой сертификат УЦ Минцифры (${String(error)}). ` +
        `Скачайте его вручную с ${ROOT_URL} и положите в ${cachePath}`,
    )
  }

  // в кеш кладём уже проверенное и пересобранное, а не то, что пришло по сети
  const verified = verifyCertificate(downloaded)
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, verified, 'utf-8')
  return verified
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd collector && pnpm vitest run src/runner/trust-anchor.test.ts`
Expected: PASS (четыре теста)

- [ ] **Step 6: Коммит**

```bash
git add collector/src/runner/trust-anchor.ts collector/src/runner/trust-anchor.test.ts collector/tests/fixtures/russian_trusted_root_ca.pem
git commit -m "Якорь доверия к УЦ Минцифры с проверкой по зашитому отпечатку"
```

---

## Task 5: Отображение операций Сбербанка

**Зачем.** Это единственное место, где живут слова Сбербанка. Здесь же три правила, которых нет у Т-Банка: знак уже в сумме, счёт лежит то в `fromResource`, то в `toResource`, а заявки надо отличать от операций.

**Files:**
- Create: `collector/src/plugins/sber/types.ts`
- Create: `collector/src/plugins/sber/map.ts`
- Create: `collector/src/plugins/sber/map.test.ts`

- [ ] **Step 1: Написать падающие тесты**

Создать `collector/src/plugins/sber/map.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { parseLossless } from '../../http/lossless-json'
import { toOperations } from './map'

// Фикстуры банка приходят текстом, поэтому синтетику тоже прогоняем через
// parseLossless: только так числа станут строками, как в бою
function parse(operations: unknown[]): unknown[] {
  return parseLossless(JSON.stringify(operations)) as unknown[]
}

function outcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uohId: 'a1b2c3d4-0000-0000-0000-000000000001',
    date: '08.09.2026T11:23:45',
    form: 'ExtCardPayment',
    state: { name: 'FINANCIAL', category: 'executed' },
    description: 'Покупка',
    fromResource: { id: 'card:1111111111111111', displayedValue: 'Карта •• 1234' },
    operationAmount: { amount: -123.45, currencyCode: 'RUB' },
    classificationCode: 5411,
    isFinancial: true,
    ...overrides,
  }
}

function income(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uohId: 'a1b2c3d4-0000-0000-0000-000000000002',
    date: '08.09.2026T09:00:00',
    form: 'P2PSBPInTransfer',
    state: { name: 'FINANCIAL', category: 'executed' },
    description: 'Перевод',
    toResource: { id: 'card:1111111111111111', displayedValue: 'Карта •• 1234' },
    operationAmount: { amount: 500, currencyCode: 'RUB' },
    isFinancial: true,
    ...overrides,
  }
}

test('расход разбирается: дата, знак, вид, подсказка категории', () => {
  const [op] = toOperations(parse([outcome()]), 'card:1111111111111111')
  expect(op).toEqual({
    occurred_at: '2026-09-08',
    amount: '-123.45',
    currency: 'RUB',
    description: 'Покупка',
    external_id: 'a1b2c3d4-0000-0000-0000-000000000001',
    kind: 'purchase',
    category_hint: 'groceries',
  })
})

test('classificationCode не из четырёх цифр подсказкой не становится', () => {
  const [op] = toOperations(parse([outcome({ classificationCode: 99997668 })]), 'card:1111111111111111')
  expect(op?.category_hint).toBeNull()
})

test('отсутствие classificationCode — не ошибка', () => {
  const [op] = toOperations(parse([outcome({ classificationCode: undefined })]), 'card:1111111111111111')
  expect(op?.category_hint).toBeNull()
})

test('счёт прихода берётся из toResource, а не из fromResource', () => {
  const operations = toOperations(parse([income()]), 'card:1111111111111111')
  expect(operations).toHaveLength(1)
  expect(operations[0]?.amount).toBe('500')
  expect(operations[0]?.kind).toBe('transfer_person')
})

test('операции чужой карты отфильтровываются', () => {
  expect(toOperations(parse([outcome()]), 'card:9999999999999999')).toHaveLength(0)
})

test('заявка не импортируется', () => {
  const claim = outcome({ form: 'UfsRefinancingClaim', isFinancial: false, operationAmount: undefined })
  expect(toOperations(parse([claim]), 'card:1111111111111111')).toHaveLength(0)
})

test('сумма не проходит через float', () => {
  // JSON собирается текстом, а не через объект: литерал 12345678901234.5678 в
  // исходнике теста округляется движком ещё при разборе файла, до всякого
  // JSON.stringify. Тест, написанный через объект, терял бы точность сам и
  // падал при любой правильной реализации, ничего не проверяя
  const raw =
    '[{"uohId":"a1b2c3d4-0000-0000-0000-000000000001","date":"08.09.2026T11:23:45",' +
    '"form":"ExtCardPayment","isFinancial":true,' +
    '"fromResource":{"id":"card:1111111111111111"},' +
    '"operationAmount":{"amount":12345678901234.5678,"currencyCode":"RUB"}}]'

  const [op] = toOperations(parseLossless(raw) as unknown[], 'card:1111111111111111')
  expect(op?.amount).toBe('12345678901234.5678')
})

test('нулевая сумма — остановка, бэкенд её всё равно не примет', () => {
  const zero = outcome({ operationAmount: { amount: 0, currencyCode: 'RUB' } })
  expect(() => toOperations(parse([zero]), 'card:1111111111111111')).toThrowError(/нулевая сумма/i)
})

test('незнакомый вид операции не роняет сбор', () => {
  const strange = outcome({ form: 'СовершенноНовыйВид' })
  expect(toOperations(parse([strange]), 'card:1111111111111111')[0]?.kind).toBe('unknown')
})

test('пустое описание заменяется контрагентом', () => {
  const empty = outcome({ description: '', correspondent: 'ООО Ромашка' })
  expect(toOperations(parse([empty]), 'card:1111111111111111')[0]?.description).toBe('ООО Ромашка')
})

test('операция без uohId — остановка, дедуп на неё опирается', () => {
  const noId = outcome({ uohId: undefined })
  expect(() => toOperations(parse([noId]), 'card:1111111111111111')).toThrowError(/uohId/)
})

test('непонятная дата — остановка, а не молчаливое сегодня', () => {
  const badDate = outcome({ date: '2026-09-08 11:23:45' })
  expect(() => toOperations(parse([badDate]), 'card:1111111111111111')).toThrowError(/дат/i)
})
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/plugins/sber/map.test.ts`
Expected: FAIL — `Failed to resolve import "./map"`

- [ ] **Step 3: Написать типы**

Создать `collector/src/plugins/sber/types.ts`:

```typescript
// Модель одна на все банки; здесь только реэкспорт, чтобы импорты внутри
// плагина были короткими и симметричными Т-Банку
export type { CollectedAccount, CollectedOperation } from '../../core/contract'
```

- [ ] **Step 4: Написать отображение**

Создать `collector/src/plugins/sber/map.ts`:

```typescript
import { hintFromMcc } from '../../core/category-hints'
import type { CollectedOperation } from '../../core/contract'

/**
 * Отображение ответа Сбербанка в нашу модель. Вход — результат parseLossless,
 * поэтому все числа уже строки: сумма так строкой и остаётся на всём пути
 * (правило проекта — деньги никогда не проходят через float).
 *
 * Как и у Т-Банка, запись, которую банк считает нашей операцией, но которую мы
 * не смогли разобрать, не пропускается молча — иначе банк переименует поле, и
 * сбор отрапортует успехом с пустым импортом. Намеренных тихих фильтра два:
 * isFinancial=false (это заявка, а не деньги) и операции чужой карты.
 */
export function toOperations(raw: readonly unknown[], accountId: string): CollectedOperation[] {
  const result: CollectedOperation[] = []
  for (const item of raw) {
    const operation = toOperation(item, accountId)
    if (operation) result.push(operation)
  }
  return result
}

function toOperation(item: unknown, accountId: string): CollectedOperation | null {
  if (!isRecord(item)) throw new Error('Операция в ответе банка пришла не объектом')

  // заявки (рефинансирование и подобное) приходят вперемешку с операциями и
  // денег не двигают; у них может не быть ни суммы, ни счёта
  if (item['isFinancial'] === false) return null

  const id = getStr(item, 'uohId')
  if (!id) throw new Error('У операции банка нет uohId')
  const context = `Операция ${id}`

  const ids = sides(item)
  // «не поняли, чей это» и «это чужая карта» — разные вещи. Первое означает,
  // что банк сменил форму ответа, и молчать об этом нельзя: иначе сбор
  // отрапортует успехом с пустым импортом. Второе — обычный фильтр
  if (ids.length === 0) throw new Error(`${context}: не удалось определить счёт операции`)
  if (!ids.includes(accountId)) return null

  const amount = requireAmount(item, context)
  const currency = requireCurrency(item, context)
  const description = getStr(item, 'description')
  const correspondent = getStr(item, 'correspondent')

  return {
    occurred_at: toIsoDate(getStr(item, 'date'), context),
    amount,
    currency,
    description: limitDescription(description && description.length > 0 ? description : (correspondent ?? '')),
    external_id: id,
    kind: resolveKind(item),
    category_hint: hintFromMcc(getStr(item, 'classificationCode')),
  }
}

/**
 * Счёт операции лежит в разных полях в зависимости от направления: у расхода в
 * fromResource, у прихода в toResource.
 *
 * Сверяем обе стороны с запрошенным счётом, а не берём первую заполненную:
 * у перевода между своими картами заполнены ОБА идентификатора, и правило
 * «первый непустой» отдало бы карту-отправителя. При сборе по карте-получателю
 * приход тогда молча исчезал бы — без ошибки и без счётчика.
 */
function sides(item: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const key of ['fromResource', 'toResource']) {
    const block = getRecord(item, key)
    const id = block ? getStr(block, 'id') : undefined
    if (id) ids.push(id)
  }
  return ids
}

// Знак у Сбербанка уже в самой сумме — в отличие от Т-Банка, где направление
// задавалось отдельным полем. Перепутать это дорого: расход записался бы
// приходом, поэтому сумму со знаком принимаем как есть и не «исправляем»
function requireAmount(item: Record<string, unknown>, context: string): string {
  const block = getRecord(item, 'operationAmount')
  const raw = block ? getStr(block, 'amount') : undefined
  if (raw === undefined) throw new Error(`${context}: не удалось разобрать сумму операции`)
  if (isZeroAmount(raw)) throw new Error(`${context}: нулевая сумма операции — бэкенд её не примет`)
  return raw
}

function isZeroAmount(value: string): boolean {
  return /^-?0(\.0+)?$/.test(value)
}

const ALPHA3_CURRENCY = /^[A-Za-z]{3}$/

function requireCurrency(item: Record<string, unknown>, context: string): string {
  const block = getRecord(item, 'operationAmount')
  const code = block ? getStr(block, 'currencyCode') : undefined
  if (!code || !ALPHA3_CURRENCY.test(code)) {
    throw new Error(`${context}: не удалось распознать валюту (банк прислал "${code ?? ''}")`)
  }
  return code.toUpperCase()
}

// Банк отдаёт дату уже по Москве и без указания зоны: ДД.ММ.ГГГГTчч:мм:сс.
// Поэтому дату не пересчитываем, а переставляем — любой пересчёт через UTC
// увёл бы ночную операцию на предыдущие сутки, а на границе месяца испортил бы
// месячную статистику
const SBER_DATE = /^(\d{2})\.(\d{2})\.(\d{4})T\d{2}:\d{2}:\d{2}$/

function toIsoDate(value: string | undefined, context: string): string {
  const match = value ? SBER_DATE.exec(value) : null
  if (!match) throw new Error(`${context}: не удалось разобрать дату операции`)
  return `${match[3]}-${match[2]}-${match[1]}`
}

const MAX_DESCRIPTION_LENGTH = 1000 // предел ParsedOperationIn.description на бэкенде

function limitDescription(value: string): string {
  return value.length > MAX_DESCRIPTION_LENGTH ? value.slice(0, MAX_DESCRIPTION_LENGTH) : value
}

// Единственное место в системе, где живёт словарь Сбербанка. Значения собраны
// на живой выборке; список заведомо неполон, и это нормально — незнакомое
// значение даёт unknown и счётчик в выводе, а не остановку сбора
const BANK_FORM_TO_KIND: Record<string, string> = {
  ExtCardPayment: 'purchase',
  UfsQRSBP: 'purchase',
  ExtCardPaymentRefund: 'purchase',
  UfsExtCardFee: 'purchase',
  UfsTransferSelf: 'transfer_self',
  P2PSBPInTransfer: 'transfer_person',
  UfsP2PSBPOutTransfer: 'transfer_person',
  UfsExtMMPLSBPOutNAcptTransfer: 'transfer_person',
  ExtCardTransferIn: 'transfer_person',
  ExtCardTransferOut: 'transfer_person',
  UfsTransferBankPartnerPhone: 'transfer_person',
  UfsOutTransfer: 'transfer_person',
  ExtCardCashIn: 'cash',
  ExtCardCashOut: 'cash',
}

function resolveKind(item: Record<string, unknown>): string {
  const form = getStr(item, 'form')
  if (form === undefined) return 'unknown'
  // проверка на собственное свойство обязательна: справочник — обычный объект,
  // и форма вроде "toString" достала бы из прототипа функцию вместо вида
  if (!Object.hasOwn(BANK_FORM_TO_KIND, form)) return 'unknown'
  return BANK_FORM_TO_KIND[form] ?? 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getStr(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}
```

Про подсказку категории отдельно: `classificationCode` передаётся в общий
`hintFromMcc` **как есть**, без своей проверки формата. Функция сама отсекает
всё, что не является четырёхзначным MCC, — а именно так выглядят мусорные
значения вроде `99997668`, встреченные разведкой. Заводить рядом вторую
проверку значило бы держать два источника правды об одном словаре: разойдясь,
они разошлись бы молча, и Сбер с Т-Банком стали бы категоризировать одну и ту
же покупку по-разному.

- [ ] **Step 5: Прогнать тесты**

Run: `cd collector && pnpm vitest run src/plugins/sber/map.test.ts`
Expected: PASS (двенадцать тестов)

- [ ] **Step 6: Коммит**

```bash
git add collector/src/plugins/sber
git commit -m "Сбербанк: отображение операций в модель приложения"
```

---

## Task 6: Отображение карт Сбербанка

**Зачем.** Единица счёта для Сбербанка — карта: история привязана к ней, а не к счёту. Остаток у кредитной и дебетовой карты берётся из разных полей.

**Files:**
- Modify: `collector/src/plugins/sber/map.ts`
- Modify: `collector/src/plugins/sber/map.test.ts`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `collector/src/plugins/sber/map.test.ts`:

```typescript
import { toAccounts } from './map'

function debitCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1200010304635762,
    name: 'Дебетовая карта',
    type: 'debit',
    state: 'active',
    number: '2202 20** **** 1234',
    availableLimit: { amount: '1500.55', currency: { code: 'RUB' } },
    ...overrides,
  }
}

function creditCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 3300131089810779,
    name: 'Кредитная карта',
    type: 'credit',
    state: 'active',
    number: '4276 55** **** 9876',
    availableLimit: { amount: '90000.00', currency: { code: 'RUB' } },
    creditOwnSum: { amount: '250.00', currency: { code: 'RUB' } },
    ...overrides,
  }
}

test('карта превращается в счёт с идентификатором вида card:<id>', () => {
  const [account] = toAccounts(parse([debitCard()]) as Record<string, unknown>[])
  expect(account).toEqual({
    id: 'card:1200010304635762',
    name: 'Дебетовая карта',
    type: 'debit',
    currency: 'RUB',
    balance: '1500.55',
    cardMasks: ['1234'],
  })
})

test('у кредитной карты остаток — собственные средства, а не доступный лимит', () => {
  const [account] = toAccounts(parse([creditCard()]) as Record<string, unknown>[])
  expect(account.balance).toBe('250.00')
})

test('шестнадцатизначный идентификатор не теряет точность', () => {
  // как и в тесте на сумму: объектный литерал округлился бы движком ещё при
  // разборе исходника (9999999999999999 стало бы 10000000000000000), и тест
  // краснел бы при любой правильной реализации, ничего не проверяя
  const raw = '[{"id":9999999999999999,"name":"Карта","type":"debit","number":"2202 20** **** 1234"}]'
  const [account] = toAccounts(parseLossless(raw) as Record<string, unknown>[])
  expect(account.id).toBe('card:9999999999999999')
})

test('карта без остатка не роняет список — остаток просто отсутствует', () => {
  const [account] = toAccounts(parse([debitCard({ availableLimit: undefined })]) as Record<string, unknown>[])
  expect(account.balance).toBeNull()
})
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/plugins/sber/map.test.ts`
Expected: FAIL — `toAccounts is not exported`

- [ ] **Step 3: Дописать отображение карт**

Добавить в `collector/src/plugins/sber/map.ts`:

```typescript
import type { CollectedAccount } from '../../core/contract'

/** Идентификатор карты в том виде, в каком его принимает фильтр истории. */
export function cardResourceId(id: string): string {
  return `card:${id}`
}

/**
 * Единица счёта для Сбербанка — карта: история привязана к ней, а счета в блоке
 * accounts своих операций не имеют вовсе. Как и у Т-Банка, список счетов
 * справочный, поэтому нераспознанная валюта здесь null, а не остановка: иначе
 * одна экзотическая карта лишила бы человека подсказки с идентификаторами.
 */
export function toAccounts(raw: readonly unknown[]): CollectedAccount[] {
  return raw.map(toAccount)
}

function toAccount(item: unknown): CollectedAccount {
  if (!isRecord(item)) throw new Error('Карта в ответе банка пришла не объектом')
  const id = getStr(item, 'id')
  if (!id) throw new Error('У карты банка нет id')

  return {
    id: cardResourceId(id),
    name: getStr(item, 'name') ?? '',
    type: getStr(item, 'type') ?? '',
    currency: cardCurrency(item),
    balance: cardBalance(item),
    cardMasks: cardMask(item),
  }
}

/**
 * У дебетовой карты остаток — доступные средства. У кредитной доступный лимит
 * включает заёмные деньги и остатком в личных финансах не является: показать
 * его как «сколько у меня есть» значило бы соврать на величину лимита. Поэтому
 * у кредитки берём собственные средства.
 */
function cardBalance(item: Record<string, unknown>): string | null {
  // Оба поля лежат на самой карте, плоско: так их отдаёт section/meta, откуда
  // берётся список счетов. Вложенный creditType с теми же именами существует,
  // но в ответе другой ручки (cardInfo), которой в allowlist нет и которую
  // коллектор не вызывает — перепутать их значит читать пустоту
  const source = getRecord(item, getStr(item, 'type') === 'credit' ? 'creditOwnSum' : 'availableLimit')
  return source ? (getStr(source, 'amount') ?? null) : null
}

function cardCurrency(item: Record<string, unknown>): string | null {
  const source = getRecord(item, getStr(item, 'type') === 'credit' ? 'creditOwnSum' : 'availableLimit')
  const currency = source ? getRecord(source, 'currency') : undefined
  const code = currency ? getStr(currency, 'code') : undefined
  return code && ALPHA3_CURRENCY.test(code) ? code.toUpperCase() : null
}

const FOUR_DIGITS = /^\d{4}$/

// Номер банк отдаёт уже замаскированным (2202 20** **** 1234); четыре цифры —
// ровно то, что принимает бэкенд в card_masks, и одна негодная метка ответила
// бы 422 на весь импорт вместе с операциями
function cardMask(item: Record<string, unknown>): string[] {
  const number = getStr(item, 'number')
  if (!number) return []
  const mask = number.replace(/\s/g, '').slice(-4)
  return FOUR_DIGITS.test(mask) ? [mask] : []
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd collector && pnpm vitest run src/plugins/sber/map.test.ts && cd .. && cd collector && pnpm lint && pnpm build`
Expected: все тесты файла зелёные, линт и типы чистые

- [ ] **Step 5: Коммит**

```bash
git add collector/src/plugins/sber
git commit -m "Сбербанк: отображение карт в счета приложения"
```

---

## Task 7: Клиент Сбербанка, пагинация и объект плагина

**Зачем.** Собрать разобранные куски в работающий плагин. Пагинация обязательна: банк отдаёт максимум 250 операций за раз, и без неё длинный период молча обрежется.

**Files:**
- Create: `collector/src/plugins/sber/client.ts`
- Create: `collector/src/plugins/sber/login.ts`
- Create: `collector/src/plugins/sber/index.ts`
- Create: `collector/src/plugins/sber/index.test.ts`
- Modify: `collector/src/plugins/registry.ts`

- [ ] **Step 1: Написать падающие тесты**

Создать `collector/src/plugins/sber/index.test.ts`:

```typescript
import { expect, test } from 'vitest'
import { BankHttpError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import { SBER_ALLOWED } from './client'
import { createSberPlugin, toSberDate } from './index'

const CREDENTIALS = { kind: 'header', name: 'Cookie', value: 'UFS-SESSION=a; UFS-TOKEN=b' } as const

function operation(index: number): Record<string, unknown> {
  return {
    uohId: `id-${index}`,
    date: '08.09.2026T11:23:45',
    form: 'ExtCardPayment',
    isFinancial: true,
    fromResource: { id: 'card:1', displayedValue: 'Карта •• 1234' },
    operationAmount: { amount: -10, currencyCode: 'RUB' },
  }
}

/** Транспорт, отвечающий заранее заданными страницами операций. */
function pagingTransport(pages: number[]): { transport: Transport; bodies: string[] } {
  const bodies: string[] = []
  let call = 0
  const transport: Transport = {
    async send(_url, options) {
      bodies.push(options.body ?? '')
      const count = pages[call] ?? 0
      call += 1
      const operations = Array.from({ length: count }, (_, i) => operation(i))
      return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, body: { operations } }) }
    },
  }
  return { transport, bodies }
}

test('дата переводится в формат банка по московскому времени', () => {
  // 2026-09-08T21:30:00Z — это уже 9 сентября по Москве
  expect(toSberDate(Date.UTC(2026, 8, 8, 21, 30, 0))).toBe('09.09.2026T00:30:00')
})

test('полная страница вызывает запрос следующей', async () => {
  const { transport, bodies } = pagingTransport([250, 250, 7])
  const plugin = createSberPlugin({ ca: '', transport })
  const operations = await plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)

  expect(operations).toHaveLength(507)
  expect(bodies).toHaveLength(3)
  expect(JSON.parse(bodies[1] ?? '{}').paginationOffset).toBe(250)
})

test('неполная страница завершает обход', async () => {
  const { transport, bodies } = pagingTransport([3])
  const plugin = createSberPlugin({ ca: '', transport })
  await plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)
  expect(bodies).toHaveLength(1)
})

test('запрос истории фильтруется по карте и по периоду', async () => {
  const { transport, bodies } = pagingTransport([0])
  const plugin = createSberPlugin({ ca: '', transport })
  await plugin.fetchOperations(CREDENTIALS, 'card:1', Date.UTC(2026, 8, 1, 0, 0, 0), Date.UTC(2026, 8, 8, 0, 0, 0))

  const sent = JSON.parse(bodies[0] ?? '{}')
  expect(sent.usedResource).toEqual(['card:1'])
  expect(sent.paginationSize).toBe(250)
  expect(sent.from).toMatch(/^\d{2}\.\d{2}\.\d{4}T\d{2}:\d{2}:\d{2}$/)
  expect(sent.to).toMatch(/^\d{2}\.\d{2}\.\d{4}T\d{2}:\d{2}:\d{2}$/)
})

test('403 означает мёртвую сессию, а не сбой', async () => {
  const transport: Transport = {
    async send() {
      return { status: 403, ok: false, text: async () => '' }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })
  expect(await plugin.isAlive(CREDENTIALS)).toBe(false)
})

test('прочие ошибки банка не выдаются за протухшую сессию', async () => {
  const transport: Transport = {
    async send() {
      return { status: 500, ok: false, text: async () => '' }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })
  await expect(plugin.isAlive(CREDENTIALS)).rejects.toBeInstanceOf(BankHttpError)
})

test('секрет не той формы отвергается понятной ошибкой', async () => {
  const plugin = createSberPlugin({ ca: '', transport: pagingTransport([0]).transport })
  await expect(plugin.fetchAccounts({ kind: 'query', name: 'sessionid', value: 'x' })).rejects.toThrowError(/заголовк/i)
})

test('в allowlist только чтение истории и списка продуктов', () => {
  expect(SBER_ALLOWED.map((endpoint) => endpoint.path)).toEqual([
    '/uoh-bh/v1/operations/list',
    '/main-screen/rest/v2/m1/web/section/meta',
  ])
})
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/plugins/sber/index.test.ts`
Expected: FAIL — `Failed to resolve import "./client"`

- [ ] **Step 3: Написать клиент**

Создать `collector/src/plugins/sber/client.ts`:

```typescript
import { AllowlistClient } from '../../http/allowlist-client'
import type { AllowedEndpoint, Credentials } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import { httpsTransport } from '../../http/transport'

export const SBER_BASE = 'https://web-node3.online.sberbank.ru'

// Два адреса — весь набор возможностей коллектора по Сбербанку.
//
// Оговорка, которую важно не потерять: у Т-Банка список состоял из GET, и
// «методом на чтение ничего не сломать» было отдельной гарантией. Сбербанк
// отдаёт данные по POST, поэтому метод здесь ничего не доказывает — гарантией
// остаётся сам список адресов, и оба они читающие.
export const SBER_ALLOWED: readonly AllowedEndpoint[] = [
  { path: '/uoh-bh/v1/operations/list', method: 'POST' },
  { path: '/main-screen/rest/v2/m1/web/section/meta', method: 'POST' },
]

interface CreateOptions {
  ca: string
  transport?: Transport
  timeoutMs?: number
}

export function createSberClient(credentials: Credentials, { ca, transport, timeoutMs }: CreateOptions): AllowlistClient {
  if (credentials.kind !== 'header') {
    throw new Error('Сбербанк ожидает секрет заголовком — сохранённая запись не той формы')
  }
  return new AllowlistClient({
    baseUrl: SBER_BASE,
    allowed: SBER_ALLOWED,
    credentials,
    // корень УЦ Минцифры заменяет системный набор: у Сбербанка его в системе
    // нет, и одновременно это проверка строже системной — доверяем одному УЦ
    transport: transport ?? httpsTransport(ca),
    timeoutMs,
  })
}
```

- [ ] **Step 4: Написать вход плагина**

Вход принадлежит плагину: он знает, какие куки нужны и по какому признаку
считать вход состоявшимся. Про браузер он при этом не знает — только про
`BrowserSession` из контракта.

Создать `collector/src/plugins/sber/login.ts`:

```typescript
import type { BrowserSession, LoginPrompt } from '../../core/contract'

const LOGIN_URL = 'https://online.sberbank.ru'
const COOKIE_ORIGIN = 'https://web-node3.online.sberbank.ru'
const LOGIN_TIMEOUT_MS = 10 * 60_000
const COOKIE_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2_000

// Разведка показала: из 23 кук, уходящих на API, сессию держат ровно эти две.
// Остальные — WAF и аналитика, без них банк отвечает так же
const NEEDED = ['UFS-SESSION', 'UFS-TOKEN'] as const

/**
 * Обе куки httpOnly: скрипты страницы их не видят, но владелец cookie jar —
 * видит. Поэтому секрет забирается из браузера, а не со страницы.
 *
 * Профиль браузера сессию не сохраняет (куки сессионные), зато сохраняет
 * признаки устройства: банк узнаёт машину и просит короткий код вместо полного
 * входа. Ради этого профиль и делается персистентным.
 */
export async function obtainSberCookies(prompt: LoginPrompt): Promise<string> {
  return prompt.withBrowser(async (session) => {
    await session.goto(LOGIN_URL)
    // признак входа — переход во внутренние разделы кабинета; в форму входа не
    // вмешиваемся, код вводит человек
    await session.waitForUrl((url) => url.pathname.startsWith('/app/'), LOGIN_TIMEOUT_MS)
    return collectCookies(session)
  })
}

/**
 * Куки появляются не одновременно с переходом в кабинет, поэтому ждём обе. Их
 * появление ещё не доказывает рабочую сессию — доказательство даёт первый же
 * запрос к API, который раннер делает сразу после входа.
 */
async function collectCookies(session: BrowserSession): Promise<string> {
  const deadline = Date.now() + COOKIE_TIMEOUT_MS
  for (;;) {
    const cookies = await session.cookies(COOKIE_ORIGIN)
    const found = NEEDED.map((name) => cookies.find((cookie) => cookie.name === name))
    const complete = found.filter((cookie): cookie is { name: string; value: string } => cookie !== undefined)
    if (complete.length === NEEDED.length) {
      return complete.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }
    if (Date.now() > deadline) {
      const missing = NEEDED.filter((name) => !cookies.some((cookie) => cookie.name === name))
      throw new Error(`Вход выполнен, но банк не оставил куки: ${missing.join(', ')} — сессии нет`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
```

- [ ] **Step 5: Написать плагин**

Создать `collector/src/plugins/sber/index.ts`:

```typescript
import type { AllowlistClient } from '../../http/allowlist-client'
import { BankHttpError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import type { BankPlugin, CollectedAccount, CollectedOperation, Credentials, LoginPrompt } from '../../core/contract'
import { createSberClient } from './client'
import { obtainSberCookies } from './login'
import { toAccounts, toOperations } from './map'

const OPERATIONS_PATH = '/uoh-bh/v1/operations/list'
const PRODUCTS_PATH = '/main-screen/rest/v2/m1/web/section/meta'

// Проверено разведкой: 250 проходит, 300 даёт 500. Берём подтверждённый предел
const PAGE_SIZE = 250
// Страховка от бесконечного обхода, если банк начнёт отдавать полные страницы
// бесконечно: 200 страниц — это 50 000 операций, заведомо больше любого периода
const MAX_PAGES = 200

interface PluginOptions {
  ca: string
  transport?: Transport
  timeoutMs?: number
}

export function createSberPlugin(options: PluginOptions): BankPlugin {
  const clientFor = (credentials: Credentials): AllowlistClient => createSberClient(credentials, options)

  return {
    name: 'sber',

    async login(prompt: LoginPrompt): Promise<Credentials> {
      return { kind: 'header', name: 'Cookie', value: await obtainSberCookies(prompt) }
    },

    async isAlive(credentials: Credentials): Promise<boolean> {
      try {
        await requestOperations(clientFor(credentials), { offset: 0, size: 1 })
        return true
      } catch (error) {
        // 403 — единственный ответ, означающий «предъявленных кук недостаточно».
        // Прочие статусы это не значат, и выдавать их за протухшую сессию нельзя:
        // получился бы круг «открыли окно входа → человек вошёл → та же ошибка»
        if (error instanceof BankHttpError && error.status === 403) return false
        throw error
      }
    },

    async fetchAccounts(credentials: Credentials): Promise<CollectedAccount[]> {
      const raw = await clientFor(credentials).postJson(PRODUCTS_PATH, { withData: true, forceUpdate: false })
      return toAccounts(cardsFrom(raw))
    },

    async fetchOperations(credentials, accountId, since, until): Promise<CollectedOperation[]> {
      const client = clientFor(credentials)
      const collected: CollectedOperation[] = []

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const raw = await requestOperations(client, {
          offset: page * PAGE_SIZE,
          size: PAGE_SIZE,
          from: toSberDate(since),
          to: toSberDate(until),
          resource: accountId,
        })
        collected.push(...toOperations(raw, accountId))
        // короткая страница означает конец периода: банк отдал всё, что было
        if (raw.length < PAGE_SIZE) return collected
      }
      throw new Error(`Обход истории не сошёлся за ${MAX_PAGES} страниц — похоже, банк перестал уменьшать выдачу`)
    },
  }
}

interface OperationsQuery {
  offset: number
  size: number
  from?: string
  to?: string
  resource?: string
}

async function requestOperations(client: AllowlistClient, query: OperationsQuery): Promise<unknown[]> {
  const body: Record<string, unknown> = {
    paginationOffset: query.offset,
    paginationSize: query.size,
    showHidden: false,
    showNotTransactionBonuses: false,
    showOpenBanking: true,
  }
  if (query.from) body['from'] = query.from
  if (query.to) body['to'] = query.to
  if (query.resource) body['usedResource'] = [query.resource]

  const raw = await client.postJson(OPERATIONS_PATH, body)
  const operations = pick(raw, ['body', 'operations'])
  // молчаливая подмена не-массива на [] неотличима от «банк прислал 0 операций»
  if (!Array.isArray(operations)) throw new Error('Банк вернул историю не массивом')
  return operations
}

function cardsFrom(raw: unknown): unknown[] {
  const cards = pick(raw, ['body', 'sections', 'technicalSection', 'sectionProductData', 'cardsInWallet', 'data'])
  if (!Array.isArray(cards)) throw new Error('Банк вернул список карт не массивом')
  return cards
}

function pick(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

// Банк принимает только ДД.ММ.ГГГГTчч:мм:сс и по московскому времени; ISO и
// epoch дают 500. hourCycle: 'h23' обязателен: с hour12: false часть сборок ICU
// отдаёт "24" вместо "00" для полуночи, и банк такую строку отвергнет
const MOSCOW = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function toSberDate(millis: number): string {
  const parts = MOSCOW.formatToParts(new Date(millis))
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) throw new Error(`Не удалось получить часть даты "${type}"`)
    return part.value
  }
  return `${value('day')}.${value('month')}.${value('year')}T${value('hour')}:${value('minute')}:${value('second')}`
}
```

- [ ] **Step 6: Зарегистрировать плагин**

В `collector/src/plugins/registry.ts` добавить Сбербанк. Плагину нужен корень сертификата, поэтому реестр становится функцией от него:

```typescript
import type { BankPlugin } from '../core/contract'
import { createSberPlugin } from './sber'
import { tbankPlugin } from './tbank'

export interface RegistryDeps {
  /**
   * Корень УЦ Минцифры добывается **лениво** и только тем банком, которому он
   * нужен. Требовать его заранее нельзя: тогда сбор по Т-Банку, которому чужой
   * УЦ не нужен вовсе, падал бы при недоступности точки раздачи сертификата.
   */
  loadCa: () => Promise<string>
}

export const BANK_NAMES: readonly string[] = ['tbank', 'sber']

export async function pluginFor(name: string, deps: RegistryDeps): Promise<BankPlugin> {
  if (name === 'tbank') return tbankPlugin
  if (name === 'sber') return createSberPlugin({ ca: await deps.loadCa() })
  throw new Error(`Неизвестный банк "${name}". Известные: ${BANK_NAMES.join(', ')}`)
}
```

Соответственно поправить `collector/src/plugins/registry.test.ts`: вызовы становятся
`await pluginFor('tbank', { loadCa: async () => '' })`, а в тест про совпадение
имён добавляется Сбербанк. Добавить отдельный тест: **выбор Т-Банка не трогает
`loadCa` вовсе** — иначе ленивость останется на словах.

- [ ] **Step 7: Прогнать тесты**

Run: `cd collector && pnpm test && pnpm lint && pnpm build`
Expected: зелено. Тесты `index.test.ts` — восемь штук.

- [ ] **Step 8: Коммит**

```bash
git add collector/src/plugins
git commit -m "Сбербанк: клиент с allowlist, вход, пагинация истории и объект плагина"
```

---

## Task 8: Окно входа и добыча кук

**Зачем.** Куки Сбербанка `httpOnly` — из страницы их не достать, только из cookie jar браузера. И браузер должен доверять корню УЦ Минцифры, которого в системе нет.

**Files:**
- Create: `collector/src/runner/browser.ts`
- Delete: `collector/src/runner/session.ts`
- Modify: `collector/src/runner/forget.ts`

- [ ] **Step 1: Написать окно браузера в оболочке**

Создать `collector/src/runner/browser.ts`, перенеся туда работу с Playwright из удаляемого `session.ts`:

```typescript
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright'
import type { BrowserSession, LoginPrompt } from '../core/contract'
import { ROOT_SPKI_SHA256 } from './trust-anchor'

/** Профиль на банк: признаки устройства у банков свои и смешивать их незачем. */
export function profileDir(bank: string): string {
  return fileURLToPath(new URL(`../../profile/${bank}`, import.meta.url))
}

export async function forgetProfile(bank: string): Promise<void> {
  await rm(profileDir(bank), { recursive: true, force: true })
}

/**
 * Окно входа. Штатный Chromium не знает УЦ Минцифры (он берёт доверие из
 * хранилища ОС), поэтому мы закрепляем ровно один открытый ключ. Это уже,
 * чем установка корня в систему: доверие расширяется на один УЦ и только
 * внутри этого процесса.
 *
 * Оговорка: флаг означает «игнорировать ошибки сертификата для этого ключа», а
 * не «считать УЦ доверенным». Для цепочек с этим ключом подавляются и прочие
 * ошибки, включая истёкший срок.
 *
 * COLLECTOR_BROWSER задаёт свой браузер — например, Яндекс.Браузер, который
 * несёт корень внутри. Тогда закрепление не нужно.
 */
interface PromptOptions {
  /**
   * Отпечаток ключа УЦ, который надо закрепить в браузере, или `undefined`,
   * если банку это не нужно. Закрепление расширяет доверие — пусть узко и
   * только на время запуска, — поэтому оно применяется адресно, а не ко всем
   * банкам подряд. Т-Банку чужой УЦ не нужен, и получать его он не должен.
   */
  pinnedSpki?: string
}

export function browserPrompt(bank: string, { pinnedSpki }: PromptOptions = {}): LoginPrompt {
  return {
    async withBrowser<T>(use: (session: BrowserSession) => Promise<T>, options: { headless?: boolean } = {}): Promise<T> {
      const executablePath = process.env['COLLECTOR_BROWSER']
      // свой браузер (Яндекс.Браузер, Atom) несёт корень внутри, закреплять нечего
      const args = !executablePath && pinnedSpki ? [`--ignore-certificate-errors-spki-list=${pinnedSpki}`] : []
      const context = await chromium.launchPersistentContext(profileDir(bank), {
        headless: options.headless ?? false,
        ...(executablePath ? { executablePath } : {}),
        args,
      })
      try {
        return await use(sessionOf(context))
      } finally {
        await context.close()
      }
    },
  }
}

function sessionOf(context: BrowserContext): BrowserSession {
  const page = async () => context.pages()[0] ?? (await context.newPage())
  return {
    async goto(url) {
      await (await page()).goto(url)
    },
    async clearCookie(name) {
      await context.clearCookies({ name })
    },
    async cookies(url) {
      return (await context.cookies(url)).map((cookie) => ({ name: cookie.name, value: cookie.value }))
    },
    async waitForUrl(match, timeout) {
      await (await page()).waitForURL((url) => match(new URL(url.href)), { timeout })
    },
    async waitForRequest(match, timeout) {
      await (await page()).waitForRequest((request) => match(new URL(request.url())), { timeout })
    },
  }
}
```

- [ ] **Step 2: Удалить старую оболочку сессии**

```bash
cd collector && rm src/runner/session.ts src/runner/session.test.ts
```

Логика Т-Банка переехала в `src/plugins/tbank/login.ts` (Task 2), работа с Playwright — в `src/runner/browser.ts`. Тесты `session.test.ts` проверяли поведение, которого в этом файле больше нет; их предметом были детали Playwright, а не наша логика.

- [ ] **Step 3: Починить «забыть доступ»**

Заменить содержимое `collector/src/runner/forget.ts`:

```typescript
import { BANK_NAMES } from '../plugins/registry'
import { forgetProfile } from './browser'
import { osSecretStore } from './secret-store'

/**
 * «Забыть» доступ — удалить и профиль браузера, и сохранённый секрет. Раньше
 * секрет жил только в профиле, теперь мест два, и забыть надо оба: иначе
 * команда врала бы про то, что доступа больше нет.
 *
 * Отсутствие профиля или записи ошибкой не считается: забыть доступ должно
 * получаться и до первого входа, и повторно.
 */
const store = osSecretStore()

for (const bank of BANK_NAMES) {
  await forgetProfile(bank)
  await store.clear(bank)
}

console.log(`Доступ забыт: ${BANK_NAMES.join(', ')}`)
```

- [ ] **Step 4: Прогнать сборку и типы**

Run: `cd collector && pnpm test && pnpm lint && pnpm build`
Expected: зелено. Если `main.ts` ещё ссылается на удалённый `session.ts` — это ожидаемо и чинится в Task 9; в этом случае временно оставить `main.ts` несобранным нельзя, поэтому Task 9 выполняется сразу следом.

- [ ] **Step 5: Коммит**

```bash
git add collector/src
git commit -m "Окно входа в оболочке и добыча кук Сбербанка"
```

---

## Task 9: Раннер — выбор банка и сессия из хранилища

**Зачем.** Связать всё вместе: выбрать банк, взять сессию из хранилища, проверить живость, собрать, отправить. Сейчас раннер знает только про Т-Банк.

**Files:**
- Modify: `collector/src/runner/config.ts`
- Modify: `collector/src/runner/config.test.ts`
- Modify: `collector/src/runner/push.ts`
- Modify: `collector/src/runner/main.ts`

- [ ] **Step 1: Написать падающие тесты конфига**

Дописать в `collector/src/runner/config.test.ts`:

```typescript
test('банк по умолчанию — Т-Банк, чтобы прежние запуски не сломались', () => {
  const config = loadConfig({ AICCOUNTANT_TOKEN: 't', AICCOUNTANT_WORKSPACE: 'w' })
  expect(config.bank).toBe('tbank')
})

test('незнакомый банк отвергается со списком известных', () => {
  expect(() => loadConfig({ AICCOUNTANT_TOKEN: 't', AICCOUNTANT_WORKSPACE: 'w', COLLECT_BANK: 'alfa' })).toThrowError(/alfa/)
})

test('пер-банковский список счетов важнее общего', () => {
  const config = loadConfig({
    AICCOUNTANT_TOKEN: 't',
    AICCOUNTANT_WORKSPACE: 'w',
    COLLECT_BANK: 'sber',
    AICCOUNTANT_ACCOUNTS: '{"общий":"a"}',
    AICCOUNTANT_ACCOUNTS_SBER: '{"card:1":"b"}',
  })
  expect(config.accountMap).toEqual({ 'card:1': 'b' })
})
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd collector && pnpm vitest run src/runner/config.test.ts`
Expected: FAIL — у `CollectorConfig` нет поля `bank`

- [ ] **Step 3: Дополнить конфиг**

В `collector/src/runner/config.ts` добавить поле и разбор:

```typescript
import { BANK_NAMES } from '../plugins/registry'

// ... в интерфейс CollectorConfig:
  /** Какой банк собираем в этом запуске. */
  bank: string

// ... в loadConfig, рядом с остальными полями:
    bank: parseBank(env['COLLECT_BANK']),
    accountMap: parseAccountMap(accountsRaw(env, parseBank(env['COLLECT_BANK']))),

const DEFAULT_BANK = 'tbank'

function parseBank(raw: string | undefined): string {
  if (!raw || raw.trim() === '') return DEFAULT_BANK
  if (!BANK_NAMES.includes(raw)) {
    throw new Error(`COLLECT_BANK: неизвестный банк "${raw}". Известные: ${BANK_NAMES.join(', ')}`)
  }
  return raw
}

// Пер-банковская переменная важнее общей: у банков разные идентификаторы
// счетов, и один список на двоих означал бы, что при смене банка коллектор
// молча не найдёт ни одного счёта
function accountsRaw(env: NodeJS.ProcessEnv, bank: string): string | undefined {
  return env[`AICCOUNTANT_ACCOUNTS_${bank.toUpperCase()}`] ?? env['AICCOUNTANT_ACCOUNTS']
}
```

- [ ] **Step 4: Имя парсера берётся у плагина**

В `collector/src/runner/push.ts` имя банка становится параметром, а `parser` собирается из него:

```typescript
export async function pushOperations(
  config: CollectorConfig,
  bank: string,
  accountId: string,
  operations: readonly CollectedOperation[],
  account: CollectedAccount | undefined,
  fetchImpl: FetchImpl = fetch,
): Promise<PushResult | null> {
  // ... тело до формирования запроса не меняется
  body: JSON.stringify(requestBody(bank, operations, account)),
  // ...
}

function requestBody(bank: string, operations: readonly CollectedOperation[], account: CollectedAccount | undefined): object {
  // имя парсера выводится из имени плагина: заводить второй справочник
  // «банк → строка parser» значило бы держать два источника правды об одном
  const body = { parser: `${bank}_collector`, operations }
  if (!account || account.balance === null) return body
  return { ...body, account: { balance: account.balance, card_masks: account.cardMasks } }
}
```

В `collector/src/runner/push.test.ts` все вызовы получают вторым аргументом `'tbank'`. Значение `parser` в ответах остаётся прежним — `tbank_collector`; это и надо проверить: переезд не сменил имя парсера у Т-Банка, а значит старые импорты в приложении не осиротеют.

Добавить туда же тест на второй банк:

```typescript
test('имя парсера собирается из имени банка', async () => {
  const sent: string[] = []
  const fake: FetchImpl = async (_url, init) => {
    sent.push(init?.body as string)
    return new Response(JSON.stringify({ import_id: 'i', status: 'ready' }), { status: 201 })
  }
  const config = {
    apiBaseUrl: 'http://localhost:8000',
    apiToken: 'token',
    workspaceId: '00000000-0000-0000-0000-000000000000',
    accountMap: {},
    days: 30,
    bank: 'sber',
  }
  const operation = {
    occurred_at: '2026-09-08',
    amount: '-10.00',
    currency: 'RUB',
    description: 'Покупка',
    external_id: 'op-1',
    kind: 'purchase',
  }

  await pushOperations(config, 'sber', 'acc', [operation], undefined, fake)
  expect(JSON.parse(sent[0] ?? '{}').parser).toBe('sber_collector')
})
```

Тест намеренно собирает конфиг и операцию на месте, а не через помощников файла: их имена могли разойтись с тем, что было в `push.test.ts` до переезда, и тест не должен зависеть от того, какие из них уцелели.

- [ ] **Step 5: Переписать раннер**

Заменить содержимое `collector/src/runner/main.ts`:

```typescript
import { fileURLToPath } from 'node:url'
import type { BankPlugin, CollectedAccount, Credentials } from '../core/contract'
import { pluginFor } from '../plugins/registry'
import { browserPrompt } from './browser'
import { loadConfig, type CollectorConfig } from './config'
import { pushOperations } from './push'
import { reportMissingHints, reportUnknownKinds } from './report'
import { osSecretStore, type SecretStore } from './secret-store'
import { ROOT_SPKI_SHA256, loadTrustAnchor } from './trust-anchor'

const DAY_MS = 86_400_000
const CA_CACHE = fileURLToPath(new URL('../../profile/russian_trusted_root_ca.pem', import.meta.url))

async function main(): Promise<void> {
  const config = loadConfig()
  // сертификат добывается лениво: банку, чей УЦ известен системе, он не нужен,
  // и падать из-за недоступности точки раздачи сертификата такой сбор не должен.
  // Побочно это же и определяет, надо ли закреплять ключ УЦ в окне входа: пин
  // получает ровно тот банк, который попросил корень, — без списка банков в
  // оболочке и без расширения доверия там, где оно не нужно
  let pinnedSpki: string | undefined
  const plugin = await pluginFor(config.bank, {
    loadCa: async () => {
      pinnedSpki = ROOT_SPKI_SHA256
      return loadTrustAnchor(CA_CACHE)
    },
  })
  const store = osSecretStore()

  const credentials = await connect(plugin, store, pinnedSpki)
  const accounts = await plugin.fetchAccounts(credentials)

  if (Object.keys(config.accountMap).length === 0) {
    printAccountsHint(accounts, config.bank)
    return
  }
  assertAccountsExist(config.accountMap, accounts)
  await collect(config, plugin, credentials, accounts)
  console.log('Готово. Подтвердите импорт в приложении.')
}

/**
 * Живость сессии проверяем до всякой работы. Мёртвый секрет остаётся в
 * хранилище, и без этой проверки каждый запуск доставал бы его заново, падал
 * посреди сбора и советовал «попробуйте ещё раз» — до бесконечности.
 */
async function connect(plugin: BankPlugin, store: SecretStore, pinnedSpki: string | undefined): Promise<Credentials> {
  const saved = await store.read(plugin.name)
  if (saved && (await plugin.isAlive(saved))) return saved

  // повторную попытку внутри входа делает сам плагин: только он знает, что у
  // его банка есть дешёвая фаза обновления и когда она бесполезна
  const fresh = await plugin.login(browserPrompt(plugin.name, { pinnedSpki }))
  if (!(await plugin.isAlive(fresh))) {
    throw new Error('Вход выполнен, но банк не признал полученную сессию')
  }
  await store.write(plugin.name, fresh)
  return fresh
}

async function collect(
  config: CollectorConfig,
  plugin: BankPlugin,
  credentials: Credentials,
  accounts: readonly CollectedAccount[],
): Promise<void> {
  const until = Date.now()
  const since = until - config.days * DAY_MS

  for (const [bankAccountId, appAccountId] of Object.entries(config.accountMap)) {
    const operations = await plugin.fetchOperations(credentials, bankAccountId, since, until)
    const account = accounts.find((item) => item.id === bankAccountId)
    const result = await pushOperations(config, plugin.name, appAccountId, operations, account)
    // в консоль только идентификаторы и счётчики: ни сумм, ни описаний
    console.log(
      result
        ? `счёт ${appAccountId}: собрано ${operations.length}, импорт ${result.import_id}`
        : `счёт ${appAccountId}: операций за период нет`,
    )
    // счётчики незнакомых видов и покупок без подсказки живут в общем report.ts:
    // они одинаковы для всех банков, и вторая копия разошлась бы с первой
    reportUnknownKinds(appAccountId, operations)
    reportMissingHints(appAccountId, operations)
  }
}

// Разовая подсказка человеку на его же машине: идентификаторы счетов банка
// взять больше неоткуда. Названия здесь уместны, остатки не печатаем
function printAccountsHint(accounts: readonly CollectedAccount[], bank: string): void {
  console.log('Счета в банке:')
  for (const account of accounts) {
    console.log(`  ${account.id}  ${account.currency ?? 'валюта не распознана'}  ${account.name}`)
  }
  console.log('')
  console.log(`Задайте AICCOUNTANT_ACCOUNTS_${bank.toUpperCase()} — соответствие счетов банка счетам приложения:`)
  const example = accounts[0]?.id ?? '<счёт банка>'
  console.log(`  AICCOUNTANT_ACCOUNTS_${bank.toUpperCase()}='{"${example}":"<uuid счёта в приложении>"}'`)
}

function assertAccountsExist(accountMap: Record<string, string>, accounts: readonly CollectedAccount[]): void {
  const known = new Set(accounts.map((account) => account.id))
  const unknown = Object.keys(accountMap).filter((id) => !known.has(id))
  if (unknown.length === 0) return
  throw new Error(
    `В списке счетов указаны те, которых у банка нет: ${unknown.join(', ')}. ` +
      'Список счетов банка печатается при пустом списке.',
  )
}

await main()
```

- [ ] **Step 6: Прогнать всё**

Run: `cd collector && pnpm test && pnpm lint && pnpm build`
Expected: зелено, включая прежние тесты Т-Банка

- [ ] **Step 7: Коммит**

```bash
git add collector/src/runner
git commit -m "Раннер: выбор банка, сессия из хранилища, имя парсера от плагина"
```

---

## Task 10: README и живой прогон

**Зачем.** README сейчас описывает один банк и обещает гарантию, которой для Сбербанка нет. И ни один плагин нельзя считать готовым до первого настоящего запуска — у Т-Банка живой прогон сломал три допущения из шести.

**Files:**
- Modify: `collector/README.md`
- Modify: `README.md`

- [ ] **Step 1: Переписать README коллектора**

Привести `collector/README.md` к двум банкам. Обязательно должно появиться:

- выбор банка через `COLLECT_BANK`, список поддерживаемых;
- пер-банковские переменные счетов (`AICCOUNTANT_ACCOUNTS_TBANK`, `AICCOUNTANT_ACCOUNTS_SBER`);
- раздел про сертификат УЦ Минцифры: зачем нужен, откуда берётся, что проверяется по зашитому отпечатку, и что в хранилище ОС ничего не ставится;
- раздел про хранение доступа: у Т-Банка секрет в профиле браузера, у Сбербанка — в средствах ОС, потому что профиль сессионные куки не хранит; `pnpm forget` стирает оба места;
- **честная формулировка про allowlist.** Прежняя фраза про «только GET» для Сбербанка неверна. Написать так:

> Возможности коллектора ограничены не обещанием, а списком разрешённых
> адресов: всё остальное клиент отвергает до отправки запроса. Для Т-Банка в
> списке только запросы на чтение методом GET. Сбербанк отдаёт данные методом
> POST, поэтому там метод сам по себе безвредности не доказывает — гарантией
> остаётся сам список из двух адресов, и оба они читающие.

- [ ] **Step 2: Обновить корневой README**

Добавить Сбербанк в описание этапа с коллектором. Не обещать того, чего нет: долг по кредитке, кредиты и вклады в v1 не собираются.

- [ ] **Step 3: Живой прогон**

```bash
cd collector
COLLECT_BANK=sber AICCOUNTANT_TOKEN=... AICCOUNTANT_WORKSPACE=... pnpm collect
```

Ожидаемо: откроется окно входа, после входа коллектор напечатает список карт. Подставить полученные идентификаторы в `AICCOUNTANT_ACCOUNTS_SBER` и запустить снова.

Проверить по итогам прогона и **записать результат в раздел 12.1 спеки**:

- сошёлся ли остаток кредитной карты с тем, что показывает банк (выбор `creditOwnSum` сделан по смыслу поля, а не сверен);
- какие значения `form` пришли незнакомыми — дополнить словарь;
- переживает ли разбор реальные операции без `operationAmount` и `fromResource.id`;
- сработал ли повторный запуск: дедуп по `uohId` должен опознать всё как дубли.

- [ ] **Step 4: Коммит**

```bash
git add README.md collector/README.md docs/superpowers/specs/2026-09-08-sberbank-collector-design.md
git commit -m "Документация по коллектору Сбербанка и итоги живого прогона"
```
