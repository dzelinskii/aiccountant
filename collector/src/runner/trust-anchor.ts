import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FetchImpl } from '../http/allowlist-client'

/**
 * Отпечаток корня УЦ Минцифры зашит в код намеренно. Скачивание — удобство;
 * доверие держится на этой константе, которую видно при ревью. Файл, не
 * совпавший с ней, отвергается, а не используется «раз уж скачали».
 */
export const ROOT_SHA256 = 'd26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31'

/** Отпечаток открытого ключа — им браузер закрепляет ровно этот УЦ. */
export const ROOT_SPKI_SHA256 = 'ArgiDAcHKNt3HZrFnlRSHE7drSGng7smz98ZwdsPrjc='

const ROOT_URL = 'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt'
const PEM_BODY = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/

export function certificateFingerprint(pem: string): string {
  const match = PEM_BODY.exec(pem)
  if (!match?.[1]) throw new Error('Это не PEM-сертификат')
  const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  return createHash('sha256').update(der).digest('hex')
}

export function verifyCertificate(pem: string): void {
  const actual = certificateFingerprint(pem)
  if (actual !== ROOT_SHA256) {
    // значения отпечатков в сообщении нужны: по ним сразу видно, подменённый
    // это файл или УЦ действительно сменил корень
    throw new Error(`Отпечаток корневого сертификата не совпал: ожидали ${ROOT_SHA256}, получили ${actual}`)
  }
}

/**
 * Порядок: кеш → скачивание → проверка. Сети нет и кеша нет — падаем понятно,
 * а не идём в банк без проверки сертификата.
 *
 * Испорченный кеш (несовпадение отпечатка) не перекачивается молча поверх
 * себя же: до диска мог дотянуться кто-то посторонний, и тихая перекачка
 * замаскировала бы именно ту подмену, от которой весь этот файл защищает.
 */
export async function loadTrustAnchor(cachePath: string, fetchImpl: FetchImpl = fetch): Promise<string> {
  const cached = await readFile(cachePath, 'utf-8').catch(() => null)
  if (cached) {
    verifyCertificate(cached)
    return cached
  }

  let downloaded: string
  try {
    const res = await fetchImpl(ROOT_URL)
    if (!res.ok) throw new Error(`ответ ${res.status}`)
    downloaded = await res.text()
  } catch (error) {
    throw new Error(
      `Не удалось получить корневой сертификат УЦ Минцифры (${String(error)}). ` +
        `Скачайте его вручную с ${ROOT_URL} и положите в ${cachePath}`,
    )
  }

  verifyCertificate(downloaded)
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, downloaded, 'utf-8')
  return downloaded
}
