import { expect, test } from 'vitest'
import { BankHttpError } from '../../http/allowlist-client'
import type { Transport } from '../../http/transport'
import { SBER_ALLOWED, SBER_BASE } from './client'
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

// Заявка (isFinancial: false) — банк присылает её вперемешку с операциями, и
// в размер страницы (raw.length) она входит, но toOperations её отбрасывает
// тихо. Нужна, чтобы отличить «конец пагинации по числу
// полученных записей» (правильно) от «по числу разобранных» (неправильно
// пропустило бы хвост истории на живом банке, где заявки — обычное дело)
function droppedRequest(index: number): Record<string, unknown> {
  return {
    uohId: `request-${index}`,
    date: '08.09.2026T11:23:45',
    form: 'RefinanceRequest',
    isFinancial: false,
  }
}

/**
 * Страница с count полученными записями, из которых одна — не операция, а
 * заявка, и разбор её отбрасывает. Так raw.length (сколько банк прислал) и
 * число разобранных операций (сколько ушло вызывающей стороне) расходятся на
 * каждой странице — именно это расхождение и должен различать признак конца
 * обхода.
 */
function pageOperations(count: number): Record<string, unknown>[] {
  if (count === 0) return []
  return [droppedRequest(0), ...Array.from({ length: count - 1 }, (_, i) => operation(i))]
}

/** Транспорт, отвечающий заранее заданными страницами операций. */
function pagingTransport(pages: number[]): { transport: Transport; bodies: string[]; urls: URL[] } {
  const bodies: string[] = []
  const urls: URL[] = []
  let call = 0
  const transport: Transport = {
    async send(url, options) {
      urls.push(url)
      bodies.push(options.body ?? '')
      const count = pages[call] ?? 0
      call += 1
      const operations = pageOperations(count)
      return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, body: { operations } }) }
    },
  }
  return { transport, bodies, urls }
}

/** Транспорт с одним заранее заданным ответом на любой запрос. */
function fixedTransport(body: string): Transport {
  return {
    async send() {
      return { status: 200, ok: true, text: async () => body }
    },
  }
}

function accountsResponseBody(): string {
  return JSON.stringify({
    success: true,
    body: {
      sections: {
        technicalSection: {
          sectionProductData: {
            cardsInWallet: {
              data: [
                {
                  id: 'card-1',
                  name: 'Дебетовая карта',
                  type: 'debit',
                  number: '2202 20** **** 1234',
                  availableLimit: { amount: '1000.50', currency: { code: 'RUB' } },
                },
              ],
            },
          },
        },
      },
    },
  })
}

test('дата переводится в формат банка по московскому времени', () => {
  // 2026-11-15T21:34:47Z — это уже 16 ноября по Москве; день, месяц и секунды
  // выбраны разными, чтобы перестановка местами частей даты не осталась
  // незамеченной
  expect(toSberDate(Date.UTC(2026, 10, 15, 21, 34, 47))).toBe('16.11.2026T00:34:47')
})

test('полная страница вызывает запрос следующей', async () => {
  const { transport, bodies } = pagingTransport([250, 250, 7])
  const plugin = createSberPlugin({ ca: '', transport })
  const operations = await plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)

  // на каждой из трёх страниц одна запись — отбрасываемая заявка: 249 + 249 + 6
  expect(operations).toHaveLength(504)
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
  const since = Date.UTC(2026, 8, 1, 0, 0, 0)
  const until = Date.UTC(2026, 8, 8, 0, 0, 0)
  await plugin.fetchOperations(CREDENTIALS, 'card:1', since, until)

  const sent = JSON.parse(bodies[0] ?? '{}')
  expect(sent.usedResource).toEqual(['card:1'])
  expect(sent.paginationSize).toBe(250)
  // сверяем точные значения, а не форму строки — иначе from и to, поменянные
  // местами, тоже прошли бы проверку
  expect(sent.from).toBe(toSberDate(since))
  expect(sent.to).toBe(toSberDate(until))
})

test('тело запроса истории целиком совпадает с зафиксированными константами разведки', async () => {
  const { transport, bodies } = pagingTransport([0])
  const plugin = createSberPlugin({ ca: '', transport })
  await plugin.fetchOperations(CREDENTIALS, 'card:1', Date.UTC(2026, 8, 1, 0, 0, 0), Date.UTC(2026, 8, 8, 0, 0, 0))

  // размер страницы и три флага показа — из разведки, и все могут незаметно
  // разъехаться поодиночке; сверка целиком закрывает их разом
  expect(bodies[0]).toBe(
    '{"paginationOffset":0,"paginationSize":250,"showHidden":false,"showNotTransactionBonuses":false,' +
      '"showOpenBanking":true,"from":"01.09.2026T03:00:00","to":"08.09.2026T03:00:00","usedResource":["card:1"]}',
  )
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

test('200 с телом не той формы обязан бросать, а не выдавать себя за мёртвую сессию', async () => {
  // иначе получается бесконечный круг: живая сессия → неожиданный ответ →
  // isAlive врёт про false → окно входа → та же самая проблема формата ответа
  const plugin = createSberPlugin({ ca: '', transport: fixedTransport(JSON.stringify({ success: true, body: { operations: 'не массив' } })) })
  await expect(plugin.isAlive(CREDENTIALS)).rejects.toThrow(/массив/i)
})

test('секрет не той формы отвергается понятной ошибкой', async () => {
  const plugin = createSberPlugin({ ca: '', transport: pagingTransport([0]).transport })
  await expect(plugin.fetchAccounts({ kind: 'query', name: 'sessionid', value: 'x' })).rejects.toThrowError(/заголовк/i)
})

test('в allowlist только чтение истории, списка продуктов и деталей карты', () => {
  // третий адрес добавлен ради долга по кредитке: в списке продуктов его нет.
  // Список закреплён целиком — расширение allowlist обязано быть заметным
  expect(SBER_ALLOWED.map((endpoint) => endpoint.path)).toEqual([
    '/uoh-bh/v1/operations/list',
    '/main-screen/rest/v2/m1/web/section/meta',
    '/ufs-carddetail/rest/card/v1/cardInfo',
  ])
})

test('базовый адрес Сбербанка закреплён, и транспорт получает URL именно этого origin', async () => {
  const { transport, urls } = pagingTransport([0])
  const plugin = createSberPlugin({ ca: '', transport })
  await plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)

  expect(SBER_BASE).toBe('https://web-node3.online.sberbank.ru')
  // подмена базового адреса отправила бы куки на чужой сервер молча — вторая
  // половина гарантии (после списка путей) держится на самом origin
  expect(urls.map((url) => url.origin)).toEqual(['https://web-node3.online.sberbank.ru'])
})

test('история не массивом — исключение, а не тихая пустая история', async () => {
  const plugin = createSberPlugin({
    ca: '',
    transport: fixedTransport(JSON.stringify({ success: true, body: { operations: 'не массив' } })),
  })
  await expect(plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)).rejects.toThrow(/массив/i)
})

test('список карт не массивом — исключение, а не тихий пустой список', async () => {
  const malformed = JSON.stringify({
    success: true,
    body: { sections: { technicalSection: { sectionProductData: { cardsInWallet: { data: 'не массив' } } } } },
  })
  const plugin = createSberPlugin({ ca: '', transport: fixedTransport(malformed) })
  await expect(plugin.fetchAccounts(CREDENTIALS)).rejects.toThrow(/массив/i)
})

test('обход не сошёлся за предельное число страниц — исключение, а не молчаливая обрезка истории', async () => {
  // банк никогда не отдаёт короткую страницу — признака конца периода нет
  const transport: Transport = {
    async send() {
      const operations = Array.from({ length: 250 }, (_, i) => operation(i))
      return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, body: { operations } }) }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })
  await expect(plugin.fetchOperations(CREDENTIALS, 'card:1', 0, 1)).rejects.toThrow(/200 страниц/)
})

// Тот же конверт, но карта кредитная: долг за ней придётся спрашивать отдельно
function creditAccountsResponseBody(): string {
  return JSON.stringify({
    success: true,
    body: {
      sections: {
        technicalSection: {
          sectionProductData: {
            cardsInWallet: {
              data: [
                {
                  // идентификатор карты банк отдаёт числом, и разбор делает его
                  // строкой — обратный перевод в число проверяется ниже
                  id: 3300131089810779,
                  name: 'Кредитная карта',
                  type: 'credit',
                  number: '4276 55** **** 9876',
                  availableLimit: { amount: '2398.77', currency: { code: 'RUB' } },
                  creditOwnSum: { amount: '0.00', currency: { code: 'RUB' } },
                },
              ],
            },
          },
        },
      },
    },
  })
}

function cardInfoBody(): string {
  return JSON.stringify({
    success: true,
    body: { cards: [{ id: 'card-credit', creditType: { creditLimit: { amount: '150000.00' }, creditOwnSum: { amount: '0.00' }, creditDebt: { amount: '147601.23' } } }] },
  })
}

test('за долгом по кредитке идёт отдельный запрос, и остаток выходит отрицательным', async () => {
  const paths: string[] = []
  const bodies: string[] = []
  const transport: Transport = {
    async send(url, options) {
      paths.push(url.pathname)
      if (options.body) bodies.push(options.body)
      const isCardInfo = url.pathname === '/ufs-carddetail/rest/card/v1/cardInfo'
      return { status: 200, ok: true, text: async () => (isCardInfo ? cardInfoBody() : creditAccountsResponseBody()) }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })

  const accounts = await plugin.fetchAccounts(CREDENTIALS)

  expect(paths).toEqual(['/main-screen/rest/v2/m1/web/section/meta', '/ufs-carddetail/rest/card/v1/cardInfo'])
  // Идентификатор уходит ЧИСЛОМ: со строкой банк отвечает 500 — на живом
  // прогоне это и случилось. Кавычки вокруг идентификатора означают возврат
  // той самой ошибки
  expect(bodies[1]).toBe('{"cardIds":[3300131089810779]}')
  expect(bodies[1]).not.toContain('"3300131089810779"')
  // 0.00 − 147601.23; прежнее поведение дало бы "0.00", доступный лимит — "2398.77"
  expect(accounts[0]?.balance).toBe('-147601.23')
})

test('отказ cardInfo не роняет список счетов — кредитка приезжает без остатка', async () => {
  const transport: Transport = {
    async send(url) {
      if (url.pathname === '/ufs-carddetail/rest/card/v1/cardInfo') {
        return { status: 500, ok: false, text: async () => '' }
      }
      return { status: 200, ok: true, text: async () => creditAccountsResponseBody() }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })

  const accounts = await plugin.fetchAccounts(CREDENTIALS)

  expect(accounts).toHaveLength(1)
  expect(accounts[0]?.balance).toBeNull()
  expect(accounts[0]?.id).toBe('card:3300131089810779')
})

test('fetchAccounts разбирает вложенный ответ и уходит POST-ом на нужный адрес', async () => {
  const requests: Array<{ url: URL; method: string }> = []
  const transport: Transport = {
    async send(url, options) {
      requests.push({ url, method: options.method })
      return { status: 200, ok: true, text: async () => accountsResponseBody() }
    },
  }
  const plugin = createSberPlugin({ ca: '', transport })

  const accounts = await plugin.fetchAccounts(CREDENTIALS)

  expect(accounts).toEqual([
    { id: 'card:card-1', name: 'Дебетовая карта', type: 'debit', currency: 'RUB', balance: '1000.50', cardMasks: ['1234'] },
  ])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.method).toBe('POST')
  expect(requests[0]?.url.pathname).toBe('/main-screen/rest/v2/m1/web/section/meta')
})
