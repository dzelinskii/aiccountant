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
  withBrowser<T>(use: (session: BrowserSession) => Promise<T>): Promise<T>
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
