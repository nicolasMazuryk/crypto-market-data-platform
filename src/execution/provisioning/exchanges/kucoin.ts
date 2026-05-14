import { randomUUID } from 'node:crypto'

import ccxt from 'ccxt'

import type {
  ProvisioningAdapter,
  CreatedSubAccount,
  CreatedApiKey,
  MasterCredentials,
  TransferDirection,
  DiscoveredSubAccount,
} from './types.js'

interface KucoinSubItem {
  subUserId?: string
  subName?: string
  mainAccounts?: { currency?: string; balance?: string; available?: string }[]
  tradeAccounts?: { currency?: string; balance?: string; available?: string }[]
}

interface KucoinClient {
  privatePostSubUserCreated: (params: Record<string, unknown>) => Promise<unknown>
  privatePostSubApiKey: (params: Record<string, unknown>) => Promise<unknown>
  privatePostSubApiKeyUpdate: (params: Record<string, unknown>) => Promise<unknown>
  privateDeleteSubApiKey: (params: Record<string, unknown>) => Promise<unknown>
  privatePostAccountsSubTransfer: (params: Record<string, unknown>) => Promise<unknown>
  privateGetSubAccounts: (params: Record<string, unknown>) => Promise<unknown>
}

interface KucoinSubFuturesClient {
  futuresPrivateGetAccountOverview: (params: Record<string, unknown>) => Promise<unknown>
  futuresPrivatePostTransferOut: (params: Record<string, unknown>) => Promise<unknown>
}

function buildKucoinClient(creds: MasterCredentials): KucoinClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => KucoinClient>
  const ExchangeClass = registry.kucoin
  if (!ExchangeClass) throw new Error('kucoin not found in CCXT registry')
  return new ExchangeClass({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    password: creds.apiPassphrase,
    enableRateLimit: true,
  })
}

function buildKucoinSubFuturesClient(apiKey: string, apiSecret: string, apiPassphrase: string): KucoinSubFuturesClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => KucoinSubFuturesClient>
  const ExchangeClass = registry.kucoinfutures
  if (!ExchangeClass) throw new Error('kucoinfutures not found in CCXT registry')
  return new ExchangeClass({ apiKey, secret: apiSecret, password: apiPassphrase, enableRateLimit: true })
}

export class KucoinProvisioningAdapter implements ProvisioningAdapter {
  readonly exchange = 'kucoin' as const
  readonly mode = 'full_api' as const

  private readonly client: KucoinClient
  private readonly subName: string

  constructor(creds: MasterCredentials, label: string) {
    this.client = buildKucoinClient(creds)
    this.subName = label.replace(/[^a-zA-Z0-9]/g, '')
  }

  private async findSubByName(): Promise<KucoinSubItem> {
    const response = (await this.client.privateGetSubAccounts({})) as {
      data?: { items?: KucoinSubItem[] }
    }
    const items = response.data?.items ?? []
    const found = items.find(item => item.subName === this.subName)
    if (!found) {
      throw new Error(`KuCoin: sub-account '${this.subName}' not found in account list`)
    }
    return found
  }

  async createSubAccount(_label: string): Promise<CreatedSubAccount> {
    const response = (await this.client.privatePostSubUserCreated({
      subName: this.subName,
      password: `Prov${String(Date.now())}!`,
      remarks: _label,
      access: 'Spot,Margin,Futures',
    })) as { data?: { uid?: string | number } }

    if (!response.data?.uid) {
      throw new Error(`KuCoin createSubAccount: unexpected response — no uid: ${JSON.stringify(response)}`)
    }

    // KuCoin create returns numeric uid; actual subUserId (hex) is in the list endpoint
    const sub = await this.findSubByName()
    if (!sub.subUserId) {
      throw new Error(`KuCoin createSubAccount: could not resolve hex subUserId for '${this.subName}'`)
    }
    return { subAccountId: sub.subUserId }
  }

  async createApiKey(_subAccountId: string, ipAllowList: string[]): Promise<CreatedApiKey> {
    const passphrase = `Pass${String(Date.now())}!`
    const response = (await this.client.privatePostSubApiKey({
      subName: this.subName,
      passphrase,
      remark: `prov-${String(Date.now())}`,
      permission: this.requiredPermission(),
      ipWhitelist: ipAllowList.join(','),
    })) as {
      data?: {
        apiKey?: string
        apiSecret?: string
        passphrase?: string
      }
    }

    const apiKey = response.data?.apiKey
    const apiSecret = response.data?.apiSecret
    const apiPassphrase = response.data?.passphrase ?? passphrase
    if (!apiKey || !apiSecret) {
      throw new Error(`KuCoin createApiKey: unexpected response — missing keys: ${JSON.stringify(response)}`)
    }
    const result: CreatedApiKey = { apiKey, apiSecret }
    if (apiPassphrase) result.apiPassphrase = apiPassphrase
    return result
  }

  private requiredPermission(): string {
    return 'General,Spot,Margin,Futures,Unified,InnerTransfer'
  }

  async ensureApiKeyPermissions(
    _subAccountId: string,
    apiKey: string,
    apiPassphrase: string | null,
    ipAllowList: string[]
  ): Promise<void> {
    if (!apiPassphrase) {
      throw new Error('KuCoin ensureApiKeyPermissions: api passphrase is required to modify API key permissions')
    }
    await this.client.privatePostSubApiKeyUpdate({
      subName: this.subName,
      apiKey,
      passphrase: apiPassphrase,
      permission: this.requiredPermission(),
      ipWhitelist: ipAllowList.join(','),
    })
  }

  async listSubAccounts(): Promise<DiscoveredSubAccount[]> {
    const response = (await this.client.privateGetSubAccounts({})) as {
      data?: { items?: KucoinSubItem[] } | KucoinSubItem[]
    }
    const items = Array.isArray(response.data) ? response.data : (response.data?.items ?? [])
    return items.flatMap(item => {
      const id = item.subUserId
      if (!id) return []
      return [{ subAccountId: id, label: item.subName ?? '', frozen: false }]
    })
  }

  renameSubAccount(_subAccountId: string, _newLabel: string): Promise<void> {
    return Promise.reject(new Error('RenameNotSupported: KuCoin does not expose sub-account rename via API'))
  }

  getSubAccountUsdtBalance(_subAccountId: string): Promise<number> {
    // KuCoin Futures sub-account balance cannot be queried from the master's API key.
    // Provisioning passes allocated_capital_usdt as the assumed balance when reconciling reused entries.
    return Promise.resolve(0)
  }

  async transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void> {
    if (direction === 'master_to_sub') {
      // Master MAIN → sub CONTRACT (futures)
      const response = (await this.client.privatePostAccountsSubTransfer({
        clientOid: `prov-${String(Date.now())}`,
        currency: 'USDT',
        amount: String(amountUsdt),
        direction: 'OUT',
        accountType: 'MAIN',
        subAccountType: 'CONTRACT',
        subUserId: subAccountId,
      })) as { data?: { orderId?: string } }

      if (!response.data?.orderId) {
        throw new Error(
          `KuCoin transferUsdt (master_to_sub): unexpected response — no orderId: ${JSON.stringify(response)}`
        )
      }
      return
    }

    // sub_to_master: V1 sub-transfer does NOT support CONTRACT type for direction=IN.
    // Two-step via a temporary sub API key with General,Futures permission:
    //   1. Sub's own futures client: futures → sub MAIN
    //   2. Master's client: sub MAIN → master MAIN (V1, subAccountType=MAIN works)
    const tmpPass = `Drain${String(Date.now())}!`
    const keyResp = (await this.client.privatePostSubApiKey({
      subName: this.subName,
      passphrase: tmpPass,
      remark: 'tmp-drain',
      permission: 'General,Futures',
      ipWhitelist: '',
    })) as { data?: { apiKey?: string; apiSecret?: string } }

    const tmpApiKey = keyResp.data?.apiKey
    const tmpSecret = keyResp.data?.apiSecret
    if (!tmpApiKey || !tmpSecret) {
      throw new Error(`KuCoin transferUsdt (sub_to_master): could not create temp API key`)
    }

    let drained = 0
    try {
      const subFutures = buildKucoinSubFuturesClient(tmpApiKey, tmpSecret, tmpPass)

      // Query actual futures balance (sub's own key required)
      const balResp = (await subFutures.futuresPrivateGetAccountOverview({ currency: 'USDT' })) as {
        data?: { availableBalance?: string; marginBalance?: string }
      }
      drained = parseFloat(balResp.data?.availableBalance ?? balResp.data?.marginBalance ?? '0')

      if (drained < 0.01) return // nothing to drain

      // Step 1: sub futures → sub MAIN
      await subFutures.futuresPrivatePostTransferOut({
        bizNo: randomUUID(),
        currency: 'USDT',
        amount: String(drained),
        recAccountType: 'MAIN',
      })

      // Brief pause for settlement before pulling
      await new Promise(r => setTimeout(r, 2500))
    } finally {
      // Always clean up temp key
      try {
        await this.client.privateDeleteSubApiKey({
          subName: this.subName,
          apiKey: tmpApiKey,
          passphrase: tmpPass,
        })
      } catch {
        // Non-fatal — key will expire naturally
      }
    }

    if (drained < 0.01) return

    // Step 2: sub MAIN → master MAIN
    const pullResp = (await this.client.privatePostAccountsSubTransfer({
      clientOid: randomUUID(),
      currency: 'USDT',
      amount: String(drained),
      direction: 'IN',
      accountType: 'MAIN',
      subAccountType: 'MAIN',
      subUserId: subAccountId,
    })) as { data?: { orderId?: string } }

    if (!pullResp.data?.orderId) {
      throw new Error(
        `KuCoin transferUsdt (sub_to_master): step2 pull failed — no orderId: ${JSON.stringify(pullResp)}`
      )
    }
  }
}
