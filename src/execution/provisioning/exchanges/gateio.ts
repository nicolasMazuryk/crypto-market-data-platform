import ccxt from 'ccxt'

import type {
  CreatedApiKey,
  CreatedSubAccount,
  DiscoveredSubAccount,
  MasterCredentials,
  ProvisioningAdapter,
  TransferDirection,
} from './types.js'

interface GateioClient {
  privateSubAccountsPostSubAccounts: (params: Record<string, unknown>) => Promise<unknown>
  privateSubAccountsPostSubAccountsUserIdKeys: (params: Record<string, unknown>) => Promise<unknown>
  privateSubAccountsPutSubAccountsUserIdKeysKey: (params: Record<string, unknown>) => Promise<unknown>
  privateSubAccountsGetSubAccounts: (params: Record<string, unknown>) => Promise<unknown>
  privateSubAccountsGetSubAccountsUserId: (params: Record<string, unknown>) => Promise<unknown>
  privateWalletGetSubAccountFuturesBalances: (params: Record<string, unknown>) => Promise<unknown>
  privateWalletPostSubAccountTransfers: (params: Record<string, unknown>) => Promise<unknown>
}

const GATEIO_REQUIRED_KEY_PERMS = [
  'wallet',
  'spot',
  'futures',
  'delivery',
  'earn',
  'custody',
  'options',
  'account',
  'loan',
  'margin',
  'unified',
  'copy',
] as const

function buildGateioClient(creds: MasterCredentials): GateioClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => GateioClient>
  const ExchangeClass = registry.gateio
  if (!ExchangeClass) throw new Error('gateio not found in CCXT registry')
  return new ExchangeClass({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    enableRateLimit: true,
  })
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export class GateioProvisioningAdapter implements ProvisioningAdapter {
  readonly exchange = 'gateio' as const
  readonly mode = 'full_api' as const

  private readonly client: GateioClient

  constructor(creds: MasterCredentials) {
    this.client = buildGateioClient(creds)
  }

  async createSubAccount(label: string): Promise<CreatedSubAccount> {
    const loginName = label.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32)
    const response = (await this.client.privateSubAccountsPostSubAccounts({
      login_name: loginName,
      remark: label,
    })) as { user_id?: string | number; uid?: string | number }
    const id = response.user_id ?? response.uid
    if (!id) throw new Error(`Gate.io createSubAccount: unexpected response: ${JSON.stringify(response)}`)
    return { subAccountId: String(id) }
  }

  async createApiKey(subAccountId: string, ipAllowList: string[]): Promise<CreatedApiKey> {
    const response = (await this.client.privateSubAccountsPostSubAccountsUserIdKeys({
      user_id: subAccountId,
      mode: 1,
      name: `prov-${String(Date.now())}`,
      perms: this.requiredKeyPerms(),
      ip_whitelist: ipAllowList,
    })) as { key?: string; secret?: string }
    if (!response.key || !response.secret) {
      throw new Error(`Gate.io createApiKey: unexpected response: ${JSON.stringify(response)}`)
    }
    return { apiKey: response.key, apiSecret: response.secret }
  }

  private requiredKeyPerms(): { name: string; read_only: boolean }[] {
    return GATEIO_REQUIRED_KEY_PERMS.map(name => ({ name, read_only: false }))
  }

  async ensureApiKeyPermissions(
    subAccountId: string,
    apiKey: string,
    _apiPassphrase: string | null,
    ipAllowList: string[]
  ): Promise<void> {
    await this.client.privateSubAccountsPutSubAccountsUserIdKeysKey({
      user_id: subAccountId,
      key: apiKey,
      mode: 1,
      name: `prov-${String(Date.now())}`,
      perms: this.requiredKeyPerms(),
      ip_whitelist: ipAllowList,
    })
  }

  async listSubAccounts(): Promise<DiscoveredSubAccount[]> {
    const response = (await this.client.privateSubAccountsGetSubAccounts({})) as unknown[] | { data?: unknown[] }
    const items = Array.isArray(response) ? response : (response.data ?? [])
    return items.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const id = row.user_id ?? row.uid
      if (id === undefined || id === null) return []
      const label = scalarString(row.remark ?? row.login_name) || scalarString(id)
      const frozen = row.state === 'locked' || row.status === 'locked'
      return [{ subAccountId: scalarString(id), label, frozen }]
    })
  }

  renameSubAccount(_subAccountId: string, _newLabel: string): Promise<void> {
    return Promise.reject(new Error('RenameNotSupported: Gate.io does not expose sub-account rename via API'))
  }

  async getSubAccountUsdtBalance(subAccountId: string): Promise<number> {
    const response = (await this.client.privateWalletGetSubAccountFuturesBalances({
      user_id: subAccountId,
      settle: 'usdt',
    })) as unknown[] | { data?: unknown[] }
    const items = Array.isArray(response) ? response : (response.data ?? [])
    const usdt = items.find(item => {
      if (!item || typeof item !== 'object') return false
      const row = item as Record<string, unknown>
      return scalarString(row.uid) === subAccountId || row.currency === 'USDT'
    }) as Record<string, unknown> | undefined
    const available = usdt?.available as Record<string, unknown> | undefined
    const lowerUsdt = available?.usdt as Record<string, unknown> | undefined
    const upperUsdt = available?.USDT as Record<string, unknown> | undefined
    return parseFloat(
      scalarString(
        lowerUsdt?.total ??
          lowerUsdt?.available ??
          lowerUsdt?.cross_margin_balance ??
          upperUsdt?.total ??
          upperUsdt?.available ??
          usdt?.balance ??
          usdt?.total
      ) || '0'
    )
  }

  async transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void> {
    await this.client.privateWalletPostSubAccountTransfers({
      sub_account: subAccountId,
      currency: 'USDT',
      amount: amountUsdt.toFixed(6),
      direction: direction === 'master_to_sub' ? 'to' : 'from',
      sub_account_type: 'futures',
    })
  }
}
