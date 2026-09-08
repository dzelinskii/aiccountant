import { createHash, createPublicKey } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fetchPublicText } from '../http/public-fetch'
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
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g
const PEM_LINE_LENGTH = 64

/**
 * Достаёт DER ровно одного сертификата. Блоков не один — это уже отказ, а не
 * повод разобрать первый и забыть про остальные: PEM с приписанным вторым
 * сертификатом идёт дальше в node:https как список из нескольких доверенных
 * корней, и посторонний блок тихо станет доверенным вместе с настоящим.
 */
function parseSingleCertificateDer(pem: string): Buffer {
  const blocks = [...pem.matchAll(PEM_BLOCK)]
  if (blocks.length === 0) throw new Error('Это не PEM-сертификат')
  if (blocks.length > 1) {
    throw new Error(
      `В PEM найдено сертификатных блоков: ${blocks.length}, ожидался ровно один — посторонний блок должен ` +
        'быть ошибкой, а не молча проигнорированным',
    )
  }
  const body = blocks[0]?.[1]
  if (body === undefined) throw new Error('Это не PEM-сертификат')
  return Buffer.from(body.replace(/\s+/g, ''), 'base64')
}

/** Канонический PEM из проверенных DER-байт — не то, что лежало в файле, а ровно то, что проверено. */
function toPem(der: Buffer): string {
  const base64 = der.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += PEM_LINE_LENGTH) lines.push(base64.slice(i, i + PEM_LINE_LENGTH))
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

function derFingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex')
}

export function certificateFingerprint(pem: string): string {
  return derFingerprint(parseSingleCertificateDer(pem))
}

/** Отпечаток открытого ключа сертификата — тем же способом, каким его закрепляет браузер. */
export function spkiFingerprint(pem: string): string {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('base64')
}

// значения отпечатков в сообщении нужны: по ним сразу видно, подменённый это
// файл или УЦ действительно сменил корень
function ensureFingerprintMatches(der: Buffer): void {
  const actual = derFingerprint(der)
  if (actual !== ROOT_SHA256) {
    throw new Error(`Отпечаток корневого сертификата не совпал: ожидали ${ROOT_SHA256}, получили ${actual}`)
  }
}

export function verifyCertificate(pem: string): void {
  ensureFingerprintMatches(parseSingleCertificateDer(pem))
}

/**
 * Проверяет PEM и возвращает канонически пересобранный текст из проверенных
 * DER-байт. Наружу уезжает только то, что реально проверено: что бы ни лежало
 * в файле сверх единственного блока, оно отсекается ещё в parseSingleCertificateDer.
 *
 * cachePath передан — значит, PEM пришёл из кеша на диске, и ошибка должна
 * называть файл и подсказывать удалить его: до диска мог дотянуться кто-то
 * посторонний, и голое «не совпал X/Y» не говорит человеку, что делать.
 */
function verifyAndCanonicalize(pem: string, cachePath?: string): string {
  try {
    const der = parseSingleCertificateDer(pem)
    ensureFingerprintMatches(der)
    return toPem(der)
  } catch (error) {
    if (cachePath === undefined) throw error
    throw new Error(
      `Кеш корневого сертификата УЦ Минцифры повреждён (${cachePath}): ${String(error instanceof Error ? error.message : error)}. ` +
        'Удалите этот файл и запустите заново — сертификат будет скачан и проверен заново.',
    )
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
export async function loadTrustAnchor(cachePath: string, fetchImpl?: FetchImpl): Promise<string> {
  const cached = await readFile(cachePath, 'utf-8').catch(() => null)
  if (cached) {
    return verifyAndCanonicalize(cached, cachePath)
  }

  let downloaded: string
  try {
    downloaded = await fetchPublicText(ROOT_URL, fetchImpl)
  } catch (error) {
    throw new Error(
      `Не удалось получить корневой сертификат УЦ Минцифры (${String(error)}). ` +
        `Скачайте его вручную с ${ROOT_URL} и положите в ${cachePath}`,
    )
  }

  const canonical = verifyAndCanonicalize(downloaded)
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, canonical, 'utf-8')
  return canonical
}
