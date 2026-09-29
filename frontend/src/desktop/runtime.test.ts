import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const tauriInvoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }))

import { invoke, isDesktop } from './runtime'

beforeEach(() => {
  tauriInvoke.mockReset()
})

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

test('isDesktop в обычном браузере — false', () => {
  expect(isDesktop()).toBe(false)
})

test('isDesktop в окне Tauri — true', () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  expect(isDesktop()).toBe(true)
})

test('invoke отдаёт результат команды и передаёт ей имя и аргументы', async () => {
  tauriInvoke.mockResolvedValueOnce('tok')
  await expect(invoke<string>('app_token_read', { a: 1 })).resolves.toBe('tok')
  expect(tauriInvoke).toHaveBeenCalledWith('app_token_read', { a: 1 })
})

test('invoke превращает отказ строкой в Error с тем же сообщением', async () => {
  tauriInvoke.mockRejectedValueOnce('keyring недоступен')
  const result = invoke('app_token_read')
  await expect(result).rejects.toThrow(Error)
  await expect(result).rejects.toThrow('keyring недоступен')
})

test('invoke пробрасывает Error как есть, не заворачивая', async () => {
  const original = new Error('сбой')
  tauriInvoke.mockRejectedValueOnce(original)
  await expect(invoke('app_token_read')).rejects.toBe(original)
})
