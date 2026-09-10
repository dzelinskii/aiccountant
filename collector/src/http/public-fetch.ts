import type { FetchImpl } from './allowlist-client'

/**
 * Скачивание публичного текста по фиксированному адресу — вне AllowlistClient,
 * но не в обход его смысла: адрес приходит константой из нашего же кода, а не
 * из ответа банка, и секретов в запросе нет, поэтому allowlist тут просто
 * нечего защищать. Пример — публичный корневой сертификат УЦ (trust-anchor.ts).
 */
export async function fetchPublicText(url: string, fetchImpl: FetchImpl = fetch): Promise<string> {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`ответ ${res.status}`)
  return res.text()
}
