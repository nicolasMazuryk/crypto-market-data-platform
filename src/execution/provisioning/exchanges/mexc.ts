import ccxt from 'ccxt'

import type {
  ProvisioningAdapter,
  CreatedSubAccount,
  CreatedApiKey,
  MasterCredentials,
  TransferDirection,
  DiscoveredSubAccount,
} from './types.js'

interface MexcClient {
  spotPrivatePostSubAccountVirtualSubAccount: (params: Record<string, unknown>) => Promise<unknown>
  spotPrivatePostSubAccountApiKey: (params: Record<string, unknown>) => Promise<unknown>
  spotPrivatePostCapitalSubAccountUniversalTransfer: (params: Record<string, unknown>) => Promise<unknown>
  spotPrivateGetSubAccountAsset: (params: Record<string, unknown>) => Promise<unknown>
  spotPrivateGetSubAccountList: (params: Record<string, unknown>) => Promise<unknown>
}

function buildMexcClient(creds: MasterCredentials): MexcClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => MexcClient>
  const ExchangeClass = registry.mexc
  if (!ExchangeClass) throw new Error('mexc not found in CCXT registry')
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

export class MexcProvisioningAdapter implements ProvisioningAdapter {
  readonly exchange = 'mexc' as const
  readonly mode = 'full_api' as const

  private readonly client: MexcClient

  constructor(creds: MasterCredentials) {
    this.client = buildMexcClient(creds)
  }

  async createSubAccount(label: string): Promise<CreatedSubAccount> {
    const response = (await this.client.spotPrivatePostSubAccountVirtualSubAccount({
      subUserName: label,
      note: label,
    })) as { subAccountId?: string | number; data?: { subAccountId?: string | number } }

    const id = response.subAccountId ?? response.data?.subAccountId
    if (!id) {
      throw new Error(`MEXC createSubAccount: unexpected response — no subAccountId: ${JSON.stringify(response)}`)
    }
    return { subAccountId: String(id) }
  }

  async createApiKey(subAccountId: string, ipAllowList: string[]): Promise<CreatedApiKey> {
    const response = (await this.client.spotPrivatePostSubAccountApiKey({
      subUserName: subAccountId,
      note: `prov-${String(Date.now())}`,
      permissions: 'CONTRACT',
      ip: ipAllowList.join(','),
    })) as { accessKey?: string; secretKey?: string; data?: { accessKey?: string; secretKey?: string } }

    const apiKey = response.accessKey ?? response.data?.accessKey
    const apiSecret = response.secretKey ?? response.data?.secretKey
    if (!apiKey || !apiSecret) {
      throw new Error(`MEXC createApiKey: unexpected response — missing keys: ${JSON.stringify(response)}`)
    }
    return { apiKey, apiSecret }
  }

  async listSubAccounts(): Promise<DiscoveredSubAccount[]> {
    const response = (await this.client.spotPrivateGetSubAccountList({})) as {
      subAccounts?: unknown[]
      data?: unknown[] | { subAccounts?: unknown[]; list?: unknown[] }
    }
    const data = response.data
    const items = response.subAccounts ?? (Array.isArray(data) ? data : (data?.subAccounts ?? data?.list ?? []))
    return items.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const id = row.subAccountId ?? row.subAccount ?? row.subUserName ?? row.uid
      if (id === undefined || id === null) return []
      const label = scalarString(row.subUserName ?? row.note ?? row.label) || scalarString(id)
      const frozen = scalarString(row.status).toLowerCase() === 'frozen'
      return [{ subAccountId: scalarString(id), label, frozen }]
    })
  }

  renameSubAccount(_subAccountId: string, _newLabel: string): Promise<void> {
    return Promise.reject(new Error('RenameNotSupported: MEXC does not expose sub-account rename via API'))
  }

  async getSubAccountUsdtBalance(subAccountId: string): Promise<number> {
    const response = (await this.client.spotPrivateGetSubAccountAsset({
      subAccount: subAccountId,
      accountType: 'FUTURES',
    })) as { balances?: { asset?: string; free?: string; locked?: string }[] }

    const usdt = (response.balances ?? []).find(b => b.asset === 'USDT')
    if (!usdt) return 0
    const free = parseFloat(usdt.free ?? '0')
    const locked = parseFloat(usdt.locked ?? '0')
    return free + locked
  }

  async transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void> {
    const isMasterToSub = direction === 'master_to_sub'
    const params = isMasterToSub
      ? {
          fromAccount: 'MAIN',
          toAccount: 'SUB',
          toSubAccount: subAccountId,
          fromAccountType: 'SPOT',
          toAccountType: 'FUTURES',
        }
      : {
          fromAccount: 'SUB',
          toAccount: 'MAIN',
          fromSubAccount: subAccountId,
          fromAccountType: 'FUTURES',
          toAccountType: 'SPOT',
        }

    const response = (await this.client.spotPrivatePostCapitalSubAccountUniversalTransfer({
      ...params,
      asset: 'USDT',
      amount: String(amountUsdt),
    })) as { tranId?: string | number }

    if (!response.tranId) {
      throw new Error(`MEXC transferUsdt (${direction}): unexpected response — no tranId: ${JSON.stringify(response)}`)
    }
  }
}
