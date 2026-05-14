import type { ExchangeName } from '../../exchanges/types.js'

export type ProvisioningMode = 'full_api' | 'manual_register'

export interface ExchangeCapabilities {
  exchange: ExchangeName
  mode: ProvisioningMode
  subAccountCreate: boolean
  apiKeyCreate: boolean
  ipAllowList: boolean
  masterToSubTransfer: boolean
  /** null = unlimited or unknown */
  maxSubAccounts: number | null
  notes: string
}

export const EXCHANGE_CAPABILITIES: Record<ExchangeName, ExchangeCapabilities> = {
  binance: {
    exchange: 'binance',
    mode: 'full_api',
    subAccountCreate: true,
    apiKeyCreate: true,
    ipAllowList: true,
    masterToSubTransfer: true,
    maxSubAccounts: null,
    notes:
      'Sub-account create requires broker/master tier; futures permission must be enabled per sub before key issuance',
  },
  bybit: {
    exchange: 'bybit',
    mode: 'full_api',
    subAccountCreate: true,
    apiKeyCreate: true,
    ipAllowList: true,
    masterToSubTransfer: true,
    maxSubAccounts: 20,
    notes: 'v5: create-sub-member, create-subuid-apikey accepts ips array',
  },
  okx: {
    exchange: 'okx',
    mode: 'full_api',
    subAccountCreate: true,
    apiKeyCreate: true,
    ipAllowList: true,
    masterToSubTransfer: true,
    maxSubAccounts: null,
    notes: 'v5 sub-account API requires account-level enablement and master API permissions',
  },
  mexc: {
    exchange: 'mexc',
    mode: 'full_api',
    subAccountCreate: true,
    apiKeyCreate: true,
    ipAllowList: true,
    masterToSubTransfer: true,
    maxSubAccounts: 20,
    notes: 'Spot v3 sub-account endpoints + universal transfer',
  },
  bitget: {
    exchange: 'bitget',
    mode: 'full_api',
    subAccountCreate: true,
    apiKeyCreate: true,
    ipAllowList: true,
    masterToSubTransfer: true,
    maxSubAccounts: 100,
    notes: 'create-virtual-subaccount + batch API key issuance via broker endpoints',
  },
  gateio: {
    exchange: 'gateio',
    mode: 'full_api',
    subAccountCreate: true,
    apiKeyCreate: true,
    ipAllowList: true,
    masterToSubTransfer: true,
    maxSubAccounts: null,
    notes: 'v4 sub-account, key, and transfer endpoints',
  },
  kucoin: {
    exchange: 'kucoin',
    mode: 'full_api',
    subAccountCreate: true,
    apiKeyCreate: true,
    ipAllowList: true,
    masterToSubTransfer: true,
    maxSubAccounts: 50,
    notes: '/api/v2/sub/user/created for creation; futures sub API key endpoint available',
  },
}
