import ccxt from 'ccxt'

import type {
  CreatedApiKey,
  CreatedSubAccount,
  DiscoveredSubAccount,
  MasterCredentials,
  ProvisioningAdapter,
  TransferDirection,
} from './types.js'

interface OkxClient {
  privatePostUsersSubaccountCreateSubaccount: (params: Record<string, unknown>) => Promise<unknown>
  privatePostUsersSubaccountApikey: (params: Record<string, unknown>) => Promise<unknown>
  privatePostUsersSubaccountModifyApikey: (params: Record<string, unknown>) => Promise<unknown>
  privateGetUsersSubaccountList: (params: Record<string, unknown>) => Promise<unknown>
  privateGetAccountSubaccountBalances: (params: Record<string, unknown>) => Promise<unknown>
  privateGetAssetBalances: (params: Record<string, unknown>) => Promise<unknown>
  privatePostAssetTransfer: (params: Record<string, unknown>) => Promise<unknown>
}

function buildOkxClient(creds: MasterCredentials): OkxClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => OkxClient>
  const ExchangeClass = registry.okx
  if (!ExchangeClass) throw new Error('okx not found in CCXT registry')
  return new ExchangeClass({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    password: creds.apiPassphrase,
    enableRateLimit: true,
  })
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export class OkxProvisioningAdapter implements ProvisioningAdapter {
  readonly exchange = 'okx' as const
  readonly mode = 'full_api' as const

  private readonly client: OkxClient
  private readonly apiPassphrase: string

  constructor(creds: MasterCredentials) {
    this.client = buildOkxClient(creds)
    this.apiPassphrase = creds.apiPassphrase ?? `Pass${String(Date.now())}!`
  }

  async createSubAccount(label: string): Promise<CreatedSubAccount> {
    const subAcct = label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
    const response = (await this.client.privatePostUsersSubaccountCreateSubaccount({ subAcct })) as {
      data?: { subAcct?: string }[]
    }
    const id = response.data?.[0]?.subAcct ?? subAcct
    return { subAccountId: id }
  }

  async createApiKey(subAccountId: string, ipAllowList: string[]): Promise<CreatedApiKey> {
    const response = (await this.client.privatePostUsersSubaccountApikey({
      subAcct: subAccountId,
      label: `prov-${String(Date.now())}`,
      passphrase: this.apiPassphrase,
      perm: this.requiredPermission(),
      ip: ipAllowList.join(','),
    })) as { data?: { apiKey?: string; secretKey?: string; passphrase?: string }[] }
    const first = response.data?.[0]
    if (!first?.apiKey || !first.secretKey) {
      throw new Error(`OKX createApiKey: unexpected response: ${JSON.stringify(response)}`)
    }
    return { apiKey: first.apiKey, apiSecret: first.secretKey, apiPassphrase: first.passphrase ?? this.apiPassphrase }
  }

  private requiredPermission(): string {
    return 'read_only,trade'
  }

  async ensureApiKeyPermissions(
    subAccountId: string,
    apiKey: string,
    _apiPassphrase: string | null,
    ipAllowList: string[]
  ): Promise<void> {
    await this.client.privatePostUsersSubaccountModifyApikey({
      subAcct: subAccountId,
      apiKey,
      label: `prov-${String(Date.now())}`,
      perm: this.requiredPermission(),
      ip: ipAllowList.join(','),
    })
  }

  async listSubAccounts(): Promise<DiscoveredSubAccount[]> {
    const response = (await this.client.privateGetUsersSubaccountList({})) as { data?: unknown[] }
    return (response.data ?? []).flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const id = row.subAcct
      if (id === undefined || id === null) return []
      const frozen = scalarString(row.enable ?? row.status).toLowerCase() === 'false'
      return [{ subAccountId: scalarString(id), label: scalarString(row.label) || scalarString(id), frozen }]
    })
  }

  renameSubAccount(_subAccountId: string, _newLabel: string): Promise<void> {
    return Promise.reject(new Error('RenameNotSupported: OKX does not expose sub-account rename via API'))
  }

  async getSubAccountUsdtBalance(subAccountId: string): Promise<number> {
    const response = (await this.client.privateGetAccountSubaccountBalances({
      subAcct: subAccountId,
      ccy: 'USDT',
    })) as {
      data?: { details?: { ccy?: string; cashBal?: string; availBal?: string; eq?: string }[]; totalEq?: string }[]
    }
    const account = response.data?.[0]
    const usdt = (account?.details ?? []).find(asset => asset.ccy === 'USDT')
    return parseFloat(usdt?.cashBal ?? usdt?.availBal ?? usdt?.eq ?? account?.totalEq ?? '0')
  }

  async transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void> {
    const isMasterToSub = direction === 'master_to_sub'
    if (isMasterToSub) {
      await this.transferMasterToSubTrading(subAccountId, amountUsdt)
      return
    }
    await this.client.privatePostAssetTransfer({
      ccy: 'USDT',
      amt: String(amountUsdt),
      from: '18',
      to: '6',
      subAcct: subAccountId,
      type: '2',
    })
  }

  private async transferMasterToSubTrading(subAccountId: string, amountUsdt: number): Promise<void> {
    const fundingBalance = await this.getMasterFundingUsdtBalance()
    if (fundingBalance + 0.00000001 < amountUsdt) {
      throw new Error(
        `OKX master funding USDT balance ${fundingBalance.toFixed(8)} is below required ${amountUsdt.toFixed(8)}`
      )
    }
    await this.transferMasterBucketToSubTrading(subAccountId, amountUsdt)
  }

  private async transferMasterBucketToSubTrading(subAccountId: string, amountUsdt: number): Promise<void> {
    await this.client.privatePostAssetTransfer({
      ccy: 'USDT',
      amt: String(amountUsdt),
      from: '6',
      to: '18',
      subAcct: subAccountId,
      type: '1',
    })
  }

  private async getMasterFundingUsdtBalance(): Promise<number> {
    const response = (await this.client.privateGetAssetBalances({ ccy: 'USDT' })) as {
      data?: { ccy?: string; availBal?: string; bal?: string }[]
    }
    const usdt = (response.data ?? []).find(asset => asset.ccy === 'USDT')
    return parseFloat(usdt?.availBal ?? usdt?.bal ?? '0')
  }
}
