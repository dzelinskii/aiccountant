/**
 * Отпечаток счёта банка: sha256 от «банк:идентификатор».
 *
 * Считается здесь, а не в приложении, намеренно: идентификатор счёта у банков
 * разной природы, и у Альфы это номер счёта — реквизит, по которому на счёт
 * переводят деньги. В базу приложения он не едет, а для привязки довольно
 * равенства. Банк входит в отпечаток, потому что одинаковый идентификатор в
 * двух банках ничего общего не означает.
 *
 * WebCrypto, а не node:crypto: в окне приложения Node нет, а значение то же —
 * сделанные раньше привязки остаются в силе (тест-вектор в fingerprint.test.ts).
 */
export async function accountFingerprint(bank: string, accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${bank}:${accountId}`))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
