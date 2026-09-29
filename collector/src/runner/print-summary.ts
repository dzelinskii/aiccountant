import type { CollectSummary } from '../collect/collect-bank'
import { accountsWord, reportCollected } from '../collect/report'

const SESSION_LINE = {
  stored: 'сессия: из хранилища',
  // окно входа открывалось — об этом человек должен знать, а не гадать по мигнувшему окну
  login: 'сессия: свежий вход',
} as const

/**
 * Печатает итог сбора в консоль. Отдельным модулем, а не в main.ts: main.ts
 * запускает сбор при импорте, и тестом оттуда не достать ни одной строки.
 *
 * В консоль идут только идентификаторы и счётчики: ни сумм, ни описаний.
 */
export function printSummary(summary: CollectSummary): void {
  console.log(SESSION_LINE[summary.session])

  if (summary.accounts.length === 0) {
    console.log('Ни один счёт банка не привязан к счёту приложения.')
    console.log('Заведите нужные счета на экране «Счета» и запустите сбор снова.')
    return
  }

  // при нуле привязок выше уже сказано, что не ведётся ничего, — число тут было бы повтором
  if (summary.unboundCount > 0) {
    console.log(`В банке ещё ${accountsWord(summary.unboundCount)} не ведётся. Привяжите их на экране «Счета».`)
  }

  for (const account of summary.accounts) {
    if (account.error !== null) {
      console.log(`счёт ${account.appAccountId}: ${account.error}`)
      continue
    }
    console.log(
      account.importId === null
        ? `счёт ${account.appAccountId}: операций за период нет`
        : `счёт ${account.appAccountId}: собрано ${account.collected}, импорт ${account.importId}`,
    )
    reportCollected(account.appAccountId, account.counters)
  }

  if (summary.accounts.some((account) => account.importId !== null)) {
    console.log('Готово. Подтвердите импорт в приложении.')
  }
}
