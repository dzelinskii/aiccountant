import type { BrowserSession, LoginPrompt } from 'aiccountant-collector/src/app'
import { invoke } from './runtime'

const URL_POLL_MS = 500

/** Часы ожидания. Подменяются в тестах. */
export interface WindowTiming {
  now(): number
  wait(ms: number): Promise<void>
}

const REAL_TIMING: WindowTiming = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Окно входа в банк поверх команд оболочки: своё на банк, со своим профилем. */
export function bankLoginPrompt(bank: string, timing: WindowTiming = REAL_TIMING): LoginPrompt {
  return {
    // Не «use»: линтер принимает такое имя за хук React
    async withBrowser(work, options = {}) {
      await invoke('bank_window_open', { bank, visible: !(options.headless ?? false) })
      let result: Awaited<ReturnType<typeof work>>
      try {
        result = await work(bankSession(bank, timing))
      } catch (error) {
        await closeAfterFailure(bank)
        throw error
      }
      await invoke('bank_window_close', { bank })
      return result
    },
  }
}

// Причина сбоя — ошибка работы с окном; ошибка закрытия её не должна подменять, но и
// пропадать молча не вправе. В журнал уходит только сообщение: без данных страницы
async function closeAfterFailure(bank: string): Promise<void> {
  try {
    await invoke('bank_window_close', { bank })
  } catch (closeError) {
    const reason = closeError instanceof Error ? closeError.message : String(closeError)
    console.error(`Не удалось закрыть окно банка после сбоя: ${reason}`)
  }
}

function bankSession(bank: string, timing: WindowTiming): BrowserSession {
  return {
    goto: (url) => invoke<void>('bank_window_goto', { bank, url }),
    clearCookie: (name) => invoke<void>('bank_window_clear_cookie', { bank, name }),
    cookies: (url) => invoke<Array<{ name: string; value: string }>>('bank_window_cookies', { bank, url }),
    // Переход внутри одностраничного приложения банка событием навигации не
    // сообщается, поэтому адрес опрашивается. Окно, закрытое человеком, команда
    // отвергает — ожидание прерывается этой ошибкой
    async waitForUrl(match, timeoutMs) {
      const deadline = timing.now() + timeoutMs
      for (;;) {
        const current = await invoke<string>('bank_window_url', { bank })
        if (match(new URL(current))) return
        if (timing.now() >= deadline) throw new Error('Вход в банк не завершён: время ожидания вышло')
        await timing.wait(URL_POLL_MS)
      }
    },
  }
}
