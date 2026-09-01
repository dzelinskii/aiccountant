import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright'

// Профиль держим внутри collector/ независимо от того, откуда запущена команда:
// именно этот путь закрыт .gitignore, и «забыть доступ» должно удалять ровно его
export const PROFILE_DIR = fileURLToPath(new URL('../../profile', import.meta.url))
const BANK_ORIGIN = 'https://www.tbank.ru'
const LOGIN_URL = `${BANK_ORIGIN}/login/`
const MYBANK_URL = `${BANK_ORIGIN}/mybank/`
const SESSION_COOKIE = 'psid'
const LOGIN_TIMEOUT_MS = 5 * 60_000

interface ObtainOptions {
  /** Не доверять сохранённой куке и сразу открыть окно входа. */
  forceLogin?: boolean
}

/**
 * Токен банка живёт в персистентном профиле браузера: куки там шифрует сам
 * браузер средствами ОС. Отдельного хранилища секретов не заводим, в файлы,
 * переменные окружения и конфиг токен не попадает.
 *
 * Живость сессии здесь не проверяется — это дело плагина банка, оболочка про
 * его API не знает.
 */
export async function obtainSessionToken(options: ObtainOptions = {}): Promise<string> {
  if (!options.forceLogin) {
    const saved = await withContext(true, readToken)
    if (saved) return saved
  }
  // окно входа — только видимое: человек вводит телефон и код сам
  return withContext(false, logIn)
}

/**
 * «Забыть» доступ к банку — удалить профиль целиком: другого места, где живёт
 * кука сессии, нет. Отсутствующий профиль ошибкой не считается: забыть доступ
 * должно получаться и до первого входа, и повторно.
 */
export async function forgetSession(profileDir: string = PROFILE_DIR): Promise<void> {
  await rm(profileDir, { recursive: true, force: true })
}

// Контекст закрывается ровно один раз на любом пути: и чтение куки, и вход
// живут внутри этой обёртки, а не в ветках, которые могут закрыть его дважды
async function withContext<T>(
  headless: boolean,
  use: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless })
  try {
    return await use(context)
  } finally {
    await context.close()
  }
}

async function logIn(context: BrowserContext): Promise<string> {
  // с протухшей кукой банк уводит со страницы входа обратно в ЛК, и мы бы
  // прочитали ровно тот же мёртвый токен
  await context.clearCookies({ name: SESSION_COOKIE })
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(LOGIN_URL)
  // ждём, пока человек сам введёт телефон и код: в форму входа не вмешиваемся
  await page.waitForURL((url) => url.href.startsWith(MYBANK_URL), { timeout: LOGIN_TIMEOUT_MS })
  const token = await readToken(context)
  if (!token) {
    throw new Error(`Вход выполнен, но банк не оставил куку ${SESSION_COOKIE} — сессии нет`)
  }
  return token
}

async function readToken(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies(BANK_ORIGIN)
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? null
}
