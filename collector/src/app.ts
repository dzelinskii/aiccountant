// Вход для приложения: всё, что ему нужно от коллектора, одним модулем.
// Фронт импортирует только его, и если в граф попадут встроенные модули Node
// или их глобалы, это увидит tsc фронта. Нативные пакеты вроде keyring он не
// ловит — их держим вне этого графа сами.
export { collectBank } from './collect/collect-bank'
export type { AccountResult, CollectHost, CollectSummary, SessionSource, SessionStore } from './collect/collect-bank'
export type { AppConnection } from './collect/app-connection'
export { AppHttpError } from './collect/app-api'
export { parseCredentials, serializeCredentials } from './collect/credentials-codec'
export { accountsWord } from './collect/report'
export type { CollectedCounters } from './collect/report'
export { BANK_NAMES, pluginFor } from './plugins/registry'
export type { BrowserSession, Credentials, LoginPrompt } from './core/contract'
export type { HttpResponse, SendOptions, Transport } from './http/transport'
