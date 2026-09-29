import { fileURLToPath } from 'node:url'
import { collectBank } from '../collect/collect-bank'
import { pluginFor } from '../plugins/registry'
import { browserPrompt } from './browser'
import { appConnection, loadConfig } from './config'
import { httpsTransport } from './https-transport'
import { printSummary } from './print-summary'
import { osSecretStore } from './secret-store'
import { ROOT_SPKI_SHA256, loadTrustAnchor } from './trust-anchor'

const CA_CACHE = fileURLToPath(new URL('../../profile/russian_trusted_root_ca.pem', import.meta.url))

async function main(): Promise<void> {
  const config = loadConfig()
  // Т-Банк 2026-09-29 отдал цепочку от корня Минцифры, поэтому до своего
  // удаления CLI ходит во все три банка через один транспорт с этим корнем и
  // закрепляет его ключ в окне входа у всех трёх. Спека десктопного клиента
  // (§3.1) оставляет Т-Банку и системный набор корней, а этот транспорт его
  // заменяет — CLI позволяет себе такое упрощение, пока он жив
  const transport = httpsTransport(await loadTrustAnchor(CA_CACHE))
  const summary = await collectBank({
    plugin: await pluginFor(config.bank, { transport: async () => transport }),
    sessions: osSecretStore(),
    prompt: browserPrompt(config.bank, { pinnedSpki: ROOT_SPKI_SHA256 }),
    app: appConnection(config),
    days: config.days,
  })
  printSummary(summary)
  // отказ по счёту не роняет сбор, но скрипту, запустившему CLI, он должен быть виден
  if (summary.accounts.some((account) => account.error !== null)) process.exitCode = 1
}

await main()
