import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright'
import type { BrowserSession, LoginPrompt } from '../core/contract'

/**
 * Каталог профиля браузера на банк. Признаки устройства у банков свои, поэтому
 * профиль на каждый банк.
 *
 * По умолчанию — рядом с коллектором (`collector/profile/<банк>`, путь считается
 * от файла модуля, а не от cwd: ровно он закрыт .gitignore). Профиль живёт между
 * запусками — там оседает привязка устройства и быстрый вход, поэтому со второго
 * запуска банк не просит полный вход.
 *
 * `COLLECTOR_PROFILE_DIR` переносит базу профилей в общий каталог. Тогда разные
 * копии коллектора (в первую очередь worktree при разработке) делят один
 * профиль: у банка одна привязка устройства вместо новой на каждый чекаут — это
 * и удобнее, и не выглядит перед антифродом как вход с очередного нового
 * устройства. Плата — общий профиль нельзя открыть дважды разом: два
 * одновременных живых прогона его затрут, поэтому живой прогон согласуют
 * (см. правило в CLAUDE.md, раздел «Изоляция работы»).
 */
export function profileDir(bank: string): string {
  const base = process.env['COLLECTOR_PROFILE_DIR']
  if (base) return join(resolve(base), bank)
  return fileURLToPath(new URL(`../../profile/${bank}`, import.meta.url))
}

/**
 * Отсутствие профиля ошибкой не считается: «забыть доступ» должно получаться
 * и до первого входа, и повторно.
 */
export async function forgetProfile(bank: string): Promise<void> {
  await rm(profileDir(bank), { recursive: true, force: true })
}

interface PromptOptions {
  /**
   * Отпечаток открытого ключа УЦ, который надо закрепить в браузере, или
   * `undefined`, если банку это не нужно. Закрепление расширяет доверие —
   * пусть узко и только на время запуска, — поэтому оно применяется
   * адресно, а не ко всем банкам подряд: чужой УЦ нужен не каждому банку, и
   * получать его должен только тот, кому он действительно нужен.
   */
  pinnedSpki?: string
}

/**
 * Флаги запуска браузера, отвечающие за доверие к закреплённому УЦ. Вынесено
 * отдельной функцией, потому что это единственная часть окна входа, которая
 * проверяется без живого браузера.
 *
 * Штатный Chromium не знает УЦ Минцифры (он берёт доверие из хранилища ОС),
 * поэтому для банков, которым он нужен, закрепляем ровно один открытый ключ
 * флагом запуска — это уже, чем установка корня в систему: доверие
 * расширяется на один УЦ и только внутри этого процесса.
 *
 * Оговорка: флаг означает «игнорировать ошибки сертификата для этого ключа»,
 * а не «считать УЦ доверенным». Для цепочек с этим ключом подавляются и
 * прочие ошибки, включая истёкший срок.
 *
 * Свой браузер (executablePath задан через COLLECTOR_BROWSER — например,
 * браузер, несущий корень УЦ Минцифры внутри) закрепления не требует:
 * доверие в нём уже настроено помимо нас.
 */
export function certificateArgs(pinnedSpki: string | undefined, executablePath: string | undefined): string[] {
  if (executablePath || !pinnedSpki) return []
  return [`--ignore-certificate-errors-spki-list=${pinnedSpki}`]
}

export function browserPrompt(bank: string, { pinnedSpki }: PromptOptions = {}): LoginPrompt {
  return {
    async withBrowser<T>(
      use: (session: BrowserSession) => Promise<T>,
      options: { headless?: boolean } = {},
    ): Promise<T> {
      const executablePath = process.env['COLLECTOR_BROWSER']
      const context = await chromium.launchPersistentContext(profileDir(bank), {
        headless: options.headless ?? false,
        ...(executablePath ? { executablePath } : {}),
        args: certificateArgs(pinnedSpki, executablePath),
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
