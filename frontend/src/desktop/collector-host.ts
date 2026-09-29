import {
  collectBank,
  parseCredentials,
  pluginFor,
  serializeCredentials,
  type CollectSummary,
  type SessionStore,
} from 'aiccountant-collector/src/app'
import { bankTransport } from './bank-transport'
import { bankLoginPrompt } from './bank-window'
import { serverUrl, sessionToken } from './connection'
import { invoke } from './runtime'

// тот же период, что был по умолчанию у CLI (COLLECT_DAYS)
const COLLECT_DAYS = 30

/** Секрет сессии банка — в хранилище ОС через оболочку. */
export const osSessions: SessionStore = {
  async read(bank) {
    const raw = await invoke<string | null>('secret_session_read', { bank })
    return raw === null ? null : parseCredentials(raw)
  },
  async write(bank, credentials) {
    await invoke('secret_session_write', { bank, value: serializeCredentials(credentials) })
  },
}

const running = new Set<string>()

/**
 * Одна работа с банком за раз — сбор и «забыть банк» делят эту защиту. Кнопка на
 * экране и так неактивна, но профиль банка защищает не кнопка: два открытия
 * одного профиля WebView2 разом затирают его, а хранилище секретов ОС на Windows
 * при параллельных обращениях к одному банку отвечает непоследовательно.
 */
export async function runExclusive<T>(bank: string, work: () => Promise<T>): Promise<T> {
  if (running.has(bank)) throw new Error('С этим банком уже идёт работа — дождитесь её конца')
  running.add(bank)
  try {
    return await work()
  } finally {
    running.delete(bank)
  }
}

export function collectFromApp(bank: string, workspaceId: string): Promise<CollectSummary> {
  return runExclusive(bank, () => collect(bank, workspaceId))
}

async function collect(bank: string, workspaceId: string): Promise<CollectSummary> {
  const token = sessionToken()
  if (token === null) throw new Error('Нет входа в приложение')
  const plugin = await pluginFor(bank, { transport: async (name) => bankTransport(name) })
  return collectBank({
    plugin,
    sessions: osSessions,
    prompt: bankLoginPrompt(bank),
    app: { baseUrl: serverUrl(), workspaceId, authorization: `Session ${token}` },
    days: COLLECT_DAYS,
  })
}

/** Закрывает окно банка, стирает секрет и профиль. */
export const forgetBank = (bank: string): Promise<void> => runExclusive(bank, () => invoke<void>('bank_forget', { bank }))
