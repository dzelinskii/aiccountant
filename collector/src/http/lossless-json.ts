/**
 * Разбор JSON, при котором числа остаются строками. Нужен, потому что банк
 * отдаёт суммы числами, а JSON.parse материализует их во float и теряет разряды
 * ещё до того, как мы что-либо проверим. Правило проекта — деньги никогда не
 * проходят через float.
 */
export function parseLossless(text: string): unknown {
  return JSON.parse(quoteNumbers(text))
}

function quoteNumbers(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
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
      i += 1
      continue
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (num && isValuePosition(out)) {
      out += `"${num[0]}"`
      i += num[0].length
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// число — значение, если перед ним двоеточие, запятая или открывающая скобка
function isValuePosition(out: string): boolean {
  const prev = out.replace(/\s+$/, '').slice(-1)
  return prev === ':' || prev === ',' || prev === '[' || prev === ''
}
