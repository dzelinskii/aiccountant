import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/** Фронт открыт в окне Tauri, а не во вкладке браузера. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Команда оболочки. Rust отдаёт ошибку строкой — превращаем её в Error. */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}
