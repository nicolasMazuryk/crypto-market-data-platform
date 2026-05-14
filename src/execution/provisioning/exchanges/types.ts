import type { ExchangeName } from '../../../exchanges/types.js'
import type { ProvisioningMode } from '../capabilities.js'

export interface CreatedSubAccount {
  subAccountId: string
  subAccountLabel?: string
}

export interface CreatedApiKey {
  apiKey: string
  apiSecret: string
  apiPassphrase?: string
}

export type TransferDirection = 'master_to_sub' | 'sub_to_master'

export interface DiscoveredSubAccount {
  subAccountId: string
  label: string
  frozen: boolean
}

export interface ProvisioningAdapter {
  readonly exchange: ExchangeName
  readonly mode: ProvisioningMode
  createSubAccount(label: string): Promise<CreatedSubAccount>
  createApiKey(subAccountId: string, ipAllowList: string[]): Promise<CreatedApiKey>
  ensureApiKeyPermissions?(
    subAccountId: string,
    apiKey: string,
    apiPassphrase: string | null,
    ipAllowList: string[]
  ): Promise<void>
  getSubAccountUsdtBalance(subAccountId: string): Promise<number>
  transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void>
  listSubAccounts(): Promise<DiscoveredSubAccount[]>
  renameSubAccount(subAccountId: string, newLabel: string): Promise<void>
}

export interface MasterCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase?: string
}

export function loadMasterCredentials(exchange: ExchangeName, env: NodeJS.ProcessEnv = process.env): MasterCredentials {
  const exchangePrefix = exchange.toUpperCase()
  const masterPrefix = `MASTER_${exchangePrefix}`
  const apiKey = env[`${masterPrefix}_API_KEY`] ?? env[`${exchangePrefix}_API_KEY`]
  const apiSecret = env[`${masterPrefix}_API_SECRET`] ?? env[`${exchangePrefix}_API_SECRET`]
  const apiPassphrase =
    env[`${masterPrefix}_API_PASSPHRASE`] ??
    env[`${masterPrefix}_API_PASS`] ??
    env[`${exchangePrefix}_API_PASSPHRASE`] ??
    env[`${exchangePrefix}_API_PASS`]

  if (!apiKey || !apiSecret) {
    throw new Error(
      `Missing master credentials for ${exchange}: set ${masterPrefix}_API_KEY/${masterPrefix}_API_SECRET ` +
        `or ${exchangePrefix}_API_KEY/${exchangePrefix}_API_SECRET`
    )
  }

  const creds: MasterCredentials = { apiKey, apiSecret }
  if (apiPassphrase) creds.apiPassphrase = apiPassphrase
  return creds
}
