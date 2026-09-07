/**
 * Банконезависимый словарь подсказок о категории и перевод MCC в него.
 *
 * Словарь повторяет `backend/app/core/category_hints.py` — это договор между
 * коннектором и приложением, и расходиться им нельзя: приложение отвечает 422
 * на значение, которого не знает. Ровно так же продублирован словарь видов
 * операций.
 *
 * MCC — международный стандарт, поэтому таблица лежит здесь, а не в плагине
 * конкретного банка: 5411 у Сбера значит то же, что у Т-Банка.
 */
export type CategoryHint =
  | 'groceries'
  | 'dining'
  | 'taxi'
  | 'transit'
  | 'fuel'
  | 'parking'
  | 'car'
  | 'car_rental'
  | 'travel'
  | 'utilities'
  | 'home'
  | 'mobile'
  | 'internet'
  | 'entertainment'
  | 'cinema'
  | 'music'
  | 'sports'
  | 'pharmacy'
  | 'medical'
  | 'beauty'
  | 'clothing'
  | 'jewelry'
  | 'electronics'
  | 'marketplace'
  | 'pets'
  | 'kids'
  | 'gifts'
  | 'education'
  | 'charity'
  | 'taxes'
  | 'bank_fees'
  | 'services'
  | 'ecosystem'
  | 'salary'
  | 'benefits'
  | 'interest'
  | 'cashback'

export const CATEGORY_HINTS: readonly CategoryHint[] = [
  'groceries', 'dining', 'taxi', 'transit', 'fuel', 'parking', 'car', 'car_rental', 'travel',
  'utilities', 'home', 'mobile', 'internet', 'entertainment', 'cinema', 'music', 'sports',
  'pharmacy', 'medical', 'beauty', 'clothing', 'jewelry', 'electronics', 'marketplace', 'pets',
  'kids', 'gifts', 'education', 'charity', 'taxes', 'bank_fees', 'services', 'ecosystem',
  'salary', 'benefits', 'interest', 'cashback',
]

// Коды, которые встречаются в быту. Полный список MCC — около тысячи значений,
// и переписывать его целиком незачем: незнакомый код просто не даёт подсказки.
const MCC_TO_HINT: Record<string, CategoryHint> = {
  // еда
  '5411': 'groceries', '5412': 'groceries', '5422': 'groceries', '5441': 'groceries',
  '5451': 'groceries', '5462': 'groceries', '5499': 'groceries',
  '5811': 'dining', '5812': 'dining', '5813': 'dining', '5814': 'dining',
  // транспорт
  '4121': 'taxi',
  '4111': 'transit', '4112': 'transit', '4131': 'transit', '4789': 'transit',
  '5541': 'fuel', '5542': 'fuel', '5983': 'fuel',
  '7523': 'parking', '4784': 'parking',
  '5511': 'car', '5531': 'car', '5532': 'car', '5533': 'car', '5571': 'car',
  '7531': 'car', '7534': 'car', '7535': 'car', '7538': 'car', '7542': 'car', '7549': 'car',
  '7512': 'car_rental', '7513': 'car_rental', '7519': 'car_rental',
  '4511': 'travel', '4582': 'travel', '4722': 'travel', '7011': 'travel', '5309': 'travel',
  // жильё
  '4900': 'utilities',
  '5200': 'home', '5211': 'home', '5231': 'home', '5251': 'home', '5261': 'home',
  '5712': 'home', '5713': 'home', '5714': 'home', '5718': 'home', '5719': 'home', '7699': 'home',
  // связь
  '4812': 'mobile', '4814': 'mobile',
  '4816': 'internet', '4841': 'internet', '4899': 'internet',
  // развлечения
  '7911': 'entertainment', '7922': 'entertainment', '7929': 'entertainment',
  '7932': 'entertainment', '7933': 'entertainment', '7941': 'entertainment',
  '7991': 'entertainment', '7994': 'entertainment', '7996': 'entertainment',
  '7998': 'entertainment', '7999': 'entertainment', '5971': 'entertainment',
  '7829': 'cinema', '7832': 'cinema', '7841': 'cinema',
  '5815': 'music', '5816': 'music', '5817': 'music', '5818': 'music', '5735': 'music',
  '5940': 'sports', '5941': 'sports', '7997': 'sports',
  // здоровье
  '5122': 'pharmacy', '5912': 'pharmacy',
  '8011': 'medical', '8021': 'medical', '8031': 'medical', '8041': 'medical',
  '8042': 'medical', '8043': 'medical', '8049': 'medical', '8050': 'medical',
  '8062': 'medical', '8071': 'medical', '8099': 'medical', '4119': 'medical',
  '7230': 'beauty', '7297': 'beauty', '7298': 'beauty', '5977': 'beauty',
  // прочее
  '5611': 'clothing', '5621': 'clothing', '5631': 'clothing', '5651': 'clothing',
  '5655': 'clothing', '5661': 'clothing', '5681': 'clothing', '5691': 'clothing',
  '5697': 'clothing', '5698': 'clothing', '5699': 'clothing', '5137': 'clothing',
  '5139': 'clothing', '5948': 'clothing',
  '5944': 'jewelry', '5094': 'jewelry',
  '5045': 'electronics', '5722': 'electronics', '5732': 'electronics', '5734': 'electronics',
  '5262': 'marketplace', '5300': 'marketplace', '5310': 'marketplace', '5311': 'marketplace',
  '5331': 'marketplace', '5399': 'marketplace', '5964': 'marketplace', '5965': 'marketplace',
  '5969': 'marketplace',
  '0742': 'pets', '5995': 'pets',
  '5641': 'kids', '5945': 'kids',
  '5947': 'gifts', '5992': 'gifts', '5193': 'gifts',
  '5111': 'education', '5192': 'education', '5942': 'education', '5943': 'education',
  '8211': 'education', '8220': 'education', '8241': 'education', '8244': 'education',
  '8249': 'education', '8299': 'education',
  '8398': 'charity', '8641': 'charity', '8661': 'charity',
  '9211': 'taxes', '9222': 'taxes', '9223': 'taxes', '9311': 'taxes', '9399': 'taxes',
  '7211': 'services', '7216': 'services', '7217': 'services', '7251': 'services',
  '7261': 'services', '7276': 'services', '7277': 'services', '7278': 'services',
  '7295': 'services', '7299': 'services', '7311': 'services', '7333': 'services',
  '7338': 'services', '7339': 'services', '7342': 'services', '7349': 'services',
  '7372': 'services', '7379': 'services', '7392': 'services', '7393': 'services',
  '7395': 'services', '7399': 'services',
}

// Диапазоны, где у каждой компании свой код: перечислять сотни авиалиний и
// гостиничных сетей поимённо смысла нет
const MCC_RANGES: ReadonlyArray<{ from: number; to: number; hint: CategoryHint }> = [
  { from: 3000, to: 3299, hint: 'travel' }, // авиакомпании
  { from: 3500, to: 3999, hint: 'travel' }, // гостиничные сети
]

const MCC_FORMAT = /^\d{4}$/

/**
 * Подсказка по коду торговой точки; null — кода нет, он не MCC или незнаком.
 *
 * Проверка формата обязательна и не формальна: вместо MCC Т-Банк присылает у
 * переводов заглушки вида "0 0000", "9999 9999", "18 0018". Ровно четыре цифры
 * отсекают их все, не разбирая каждую поимённо.
 *
 * Коды снятия наличных и переводов (6010, 6011, 6536 и соседние) в таблицу
 * намеренно не входят: это виды операций, а не то, на что потрачены деньги, и
 * разбираются они отдельно.
 */
export function hintFromMcc(mcc: string | undefined): CategoryHint | null {
  if (mcc === undefined || !MCC_FORMAT.test(mcc)) return null
  // проверка на собственное свойство обязательна: таблица — обычный объект,
  // и ключ вроде "toString" достал бы из прототипа функцию вместо подсказки
  if (Object.hasOwn(MCC_TO_HINT, mcc)) return MCC_TO_HINT[mcc] ?? null
  const code = Number(mcc)
  for (const range of MCC_RANGES) {
    if (code >= range.from && code <= range.to) return range.hint
  }
  return null
}
