/** Операция в том виде, в каком её принимает наше приложение. */
export interface CollectedOperation {
  occurred_at: string
  amount: string
  currency: string
  description: string
  external_id: string
}

export interface CollectedAccount {
  id: string
  name: string
  type: string
  currency: string
}
