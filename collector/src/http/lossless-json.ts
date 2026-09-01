/**
 * Разбор JSON, при котором числа остаются строками. Нужен, потому что банк
 * отдаёт суммы числами, а JSON.parse материализует их во float и теряет разряды
 * ещё до того, как мы что-либо проверим. Правило проекта — деньги никогда не
 * проходят через float.
 */
export function parseLossless(text: string): unknown {
  return JSON.parse(quoteNumbers(text))
}

// sticky-флаг: exec с lastIndex ищет совпадение строго с позиции i, не копируя
// остаток текста — на счёте с тысячами операций текст.slice(i) на каждом
// символе превращает разбор в квадратичный. Форма (0|[1-9]\d*), а не \d+,
// заодно повторяет строгость JSON.parse: «01» числом не считается.
const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y

function quoteNumbers(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  // последний значимый (не форматирующий) символ уже собранного вывода;
  // храним его явно вместо того, чтобы на каждом числе досканировать out
  // до непробельного символа — это и была вторая причина квадратичности
  let prev = ''
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      // prev внутри строки не трогаем: он уже стоит на открывающей кавычке
      // (выставлена ниже, при входе в строку) и остаётся верным до самого
      // выхода — закрывающая кавычка тот же символ, а прочитать prev раньше,
      // чем inString снова станет false, всё равно негде
      out += ch
      if (ch === '\\') {
        const escaped = text[i + 1] ?? ''
        out += escaped
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      prev = ch
      i += 1
      continue
    }
    NUMBER.lastIndex = i
    const match = isValuePosition(prev) ? NUMBER.exec(text) : null
    if (match) {
      out += `"${match[0]}"`
      prev = '"'
      i += match[0].length
      continue
    }
    out += ch
    if (!isWhitespace(ch)) prev = ch
    i += 1
  }
  return out
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

// На валидном JSON эта проверка ни на что не влияет — число и так не может
// оказаться не на своём месте. Она нужна для другого: без неё голый {1:2}
// (число вместо строкового ключа) незаметно превратился бы в {"1":2} и прошёл
// бы там, где обычный JSON.parse обязан отвергнуть вход.
function isValuePosition(prev: string): boolean {
  return prev === ':' || prev === ',' || prev === '[' || prev === ''
}
