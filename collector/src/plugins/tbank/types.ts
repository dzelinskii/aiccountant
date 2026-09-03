/** Операция в том виде, в каком её принимает наше приложение. */
export interface CollectedOperation {
  occurred_at: string
  amount: string
  currency: string
  description: string
  external_id: string
  /** Вид операции в словаре приложения; словарь банка переводится здесь, в плагине. */
  kind: string
}

export interface CollectedAccount {
  id: string
  name: string
  type: string
  /** null — валюту счёта распознать не удалось; на сбор по другим счетам это не влияет. */
  currency: string | null
  /** Остаток строкой, как отдал банк; null — банк остатка не сообщил. */
  balance: string | null
  /** Последние четыре символа номеров карт счёта; пусто, если карт нет. */
  cardMasks: string[]
}
