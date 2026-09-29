/**
 * Арифметика денег над строками. Правило проекта запрещает float для денег, а
 * разбор ответов банка нарочно оставляет числа строками — значит и считать надо
 * строками, иначе первая же операция вернёт потерянные разряды.
 *
 * Живёт в ядре, а не в плагине: вычитание понадобилось второму банку (у
 * Сбербанка — собственные минус долг, у Т-Банка — доступное минус лимит), и
 * вторая копия разошлась бы с первой.
 */

const DECIMAL = /^-?\d+(\.\d+)?$/

/** Разность двух десятичных строк. Масштаб результата — наибольший из входных. */
export function subtractDecimal(a: string, b: string): string {
  // значения в текст ошибки не кладём: это суммы
  if (!DECIMAL.test(a) || !DECIMAL.test(b)) throw new Error('Вычитание сумм: значение не десятичное число')
  const scale = Math.max(fractionLength(a), fractionLength(b))
  return fromScaled(toScaled(a, scale) - toScaled(b, scale), scale)
}

function fractionLength(value: string): number {
  const dot = value.indexOf('.')
  return dot === -1 ? 0 : value.length - dot - 1
}

// Приведение к целому в выбранном масштабе: BigInt считает точно при любой
// длине, в отличие от Number, который теряет разряды уже на пятнадцати знаках
function toScaled(value: string, scale: number): bigint {
  const negative = value.startsWith('-')
  const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.')
  const scaled = BigInt(int + frac.padEnd(scale, '0'))
  return negative ? -scaled : scaled
}

function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const int = digits.slice(0, digits.length - scale)
  const body = scale === 0 ? int : `${int}.${digits.slice(digits.length - scale)}`
  // "-0.00" бэкенд принял бы, но читается он как ошибка разбора, а не как ноль
  return negative && !/^0(\.0+)?$/.test(body) ? `-${body}` : body
}
