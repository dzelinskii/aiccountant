import { Text } from '@mantine/core'
import type { CreditFields } from '../api/ledger'
import { formatMoment } from '../lib/account'
import { formatAmount, formatMoney } from '../lib/money'

export interface AccountBalanceProps {
  account: CreditFields & {
    currency: string
    balance: string
    reported_at: string | null
  }
  /** Карточка в списке счетов выровнена вправо, на дашборде — влево. */
  align?: 'left' | 'right'
  size?: 'md' | 'lg'
}

/**
 * Числа счёта на карточке — один блок на все экраны.
 *
 * У кредитной карты человек смотрит не «сколько должен», а сколько может
 * потратить, поэтому главным становится «доступно / лимит», а остаток (чистая
 * позиция) уходит строкой ниже. Сумму по счетам это не меняет: она считается по
 * остаткам.
 *
 * Если «доступно» посчитать нельзя (лимит известен на другой момент, чем
 * остаток), число не показывается вовсе — см. credit_available. Лимит при этом
 * остаётся видимым с пометкой «замечен такого-то»: банк называет лимит только в
 * момент сбора, и «изменён» было бы догадкой.
 */
export function AccountBalance({ account, align = 'left', size = 'lg' }: AccountBalanceProps) {
  const { currency, balance, reported_at, credit_limit, credit_limit_at, credit_available } =
    account
  const ta = align === 'right' ? 'right' : undefined

  if (credit_available !== null && credit_limit !== null) {
    return (
      <div>
        <Text fw={700} size={size} ta={ta}>
          {formatAmount(credit_available)} / {formatMoney(credit_limit, currency)}
        </Text>
        <Text c="dimmed" size="xs" ta={ta}>
          доступно к трате
        </Text>
        <Text c="dimmed" size="xs" ta={ta}>
          остаток {formatMoney(balance, currency)}
          {reported_at && ` на ${formatMoment(reported_at)}`}
        </Text>
      </div>
    )
  }

  return (
    <div>
      <Text fw={700} size={size} ta={ta}>
        {formatMoney(balance, currency)}
      </Text>
      {reported_at && (
        <Text c="dimmed" size="xs" ta={ta}>
          остаток на {formatMoment(reported_at)}
        </Text>
      )}
      {credit_limit !== null && credit_limit_at !== null && (
        <Text c="dimmed" size="xs" ta={ta}>
          лимит {formatMoney(credit_limit, currency)} — замечен {formatMoment(credit_limit_at)}
        </Text>
      )}
    </div>
  )
}
