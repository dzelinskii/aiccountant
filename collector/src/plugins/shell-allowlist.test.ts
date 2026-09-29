import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import type { Credentials } from '../core/contract'
import type { Transport } from '../http/transport'
import { BANK_NAMES, pluginFor } from './registry'

// Список адресов банка один — в оболочке. Плагин ходит по своим путям, и
// расхождение с ним проявилось бы только отказом на живом сборе. Поэтому тест
// читает сам исходник оболочки, а не его копию, и сверяет в обе стороны.
const BANKS_RS = fileURLToPath(new URL('../../../desktop/src-tauri/src/banks.rs', import.meta.url))

type Pair = `${string} ${string}`

// Пара бывает и в одну строку, и разнесённой rustfmt на несколько — отсюда \s*
// вокруг каждого элемента. Разбор ограничен литералом BANKS: в тестах того же
// файла пары встречаются в другой роли.
function shellLists(): Map<string, Set<Pair>> {
  const source = readFileSync(BANKS_RS, 'utf-8')
  const literal = source.match(/pub const BANKS: &\[Bank\] = &\[([\s\S]*?)\r?\n\];/)
  expect(literal, 'в banks.rs не найден литерал BANKS').not.toBeNull()
  const lists = new Map<string, Set<Pair>>()
  const blocks = (literal?.[1] ?? '').split(/code: "/).slice(1)
  for (const block of blocks) {
    const code = block.slice(0, block.indexOf('"'))
    const pairs = [...block.matchAll(/\(\s*"(GET|POST)",\s*"([^"]+)",?\s*\)/g)].map((m): Pair => `${m[1]} ${m[2]}`)
    // регулярка, разъехавшаяся с текстом исходника, свела бы сверку к двум
    // пустым спискам — это должно падать, а не проходить
    expect(pairs.length, `в banks.rs не найдено ни одной пары для банка ${code}`).toBeGreaterThan(0)
    lists.set(code, new Set(pairs))
  }
  return lists
}

// Ответы — ровно такие, чтобы каждый вызов плагина дошёл до всех своих ручек.
// Разобраться дальше им не обязательно: что плагин спросил, записано раньше.
const SBER_CREDIT_CARDS = JSON.stringify({
  body: { sections: { technicalSection: { sectionProductData: { cardsInWallet: { data: [{ id: 42, type: 'credit' }] } } } } },
})

const CREDENTIALS: Record<string, Credentials> = {
  tbank: { kind: 'query', name: 'sessionid', value: 'token' },
  sber: { kind: 'header', name: 'Cookie', value: 'UFS-SESSION=a' },
  alfa: { kind: 'header', name: 'Cookie', value: 'GW_SESSION_AO=s; XSRF-TOKEN=x' },
}

async function pluginCalls(bank: string): Promise<Set<Pair>> {
  const calls = new Set<Pair>()
  const transport: Transport = {
    async send(url, { method }) {
      calls.add(`${method} ${url.pathname}`)
      const body = bank === 'sber' && url.pathname.includes('section/meta') ? SBER_CREDIT_CARDS : '{}'
      return { status: 200, ok: true, text: async () => body }
    },
  }
  const plugin = await pluginFor(bank, { transport: async () => transport })
  const credentials = CREDENTIALS[bank]
  expect(credentials, `нет секрета для банка ${bank}`).toBeDefined()
  const swallow = (): void => undefined
  await plugin.isAlive(credentials!).catch(swallow)
  await plugin.fetchAccounts(credentials!).catch(swallow)
  await plugin.fetchOperations(credentials!, 'account-1', 0, 1).catch(swallow)
  return calls
}

test('банки оболочки — ровно банки реестра', () => {
  expect([...shellLists().keys()].sort()).toEqual([...BANK_NAMES].sort())
})

test.each(BANK_NAMES)('%s: каждая ручка плагина разрешена оболочкой', async (bank) => {
  const allowed = shellLists().get(bank) ?? new Set()
  const called = [...(await pluginCalls(bank))]
  expect(called.length).toBeGreaterThan(0)
  expect(called.filter((pair) => !allowed.has(pair))).toEqual([])
})

test.each(BANK_NAMES)('%s: каждая пара списка оболочки вызывается плагином', async (bank) => {
  // лишняя строка в списке — возможность, которой коллектор не пользуется, а
  // скрипт окна мог бы
  const called = await pluginCalls(bank)
  const allowed = [...(shellLists().get(bank) ?? [])]
  expect(allowed.filter((pair) => !called.has(pair))).toEqual([])
})
