import ccxt from 'ccxt'

import type {
  ProvisioningAdapter,
  CreatedSubAccount,
  CreatedApiKey,
  MasterCredentials,
  TransferDirection,
  DiscoveredSubAccount,
} from './types.js'

function sanitizeBitgetSubName(label: string): string {
  const letters = label.replace(/[^a-zA-Z]/g, '')
  if (letters.length >= 8) return letters.slice(0, 8)
  return letters.padEnd(8, 'x')
}

interface BitgetClient {
  privateUserPostV2UserCreateVirtualSubaccount: (params: Record<string, unknown>) => Promise<unknown>
  privateUserPostV2UserCreateVirtualSubaccountApikey: (params: Record<string, unknown>) => Promise<unknown>
  privateUserPostV2UserModifyVirtualSubaccountApikey: (params: Record<string, unknown>) => Promise<unknown>
  privateUserPostV2UserModifyVirtualSubaccount: (params: Record<string, unknown>) => Promise<unknown>
  privateUserGetV2UserVirtualSubaccountList: (params: Record<string, unknown>) => Promise<unknown>
  privateUserGetV2UserVirtualSubaccountApikeyList: (params: Record<string, unknown>) => Promise<unknown>
  privateSpotPostV2SpotWalletSubaccountTransfer: (params: Record<string, unknown>) => Promise<unknown>
  privateMixGetV2MixAccountSubAccountAssets: (params: Record<string, unknown>) => Promise<unknown>
  privateSpotGetV2SpotAccountInfo: (params: Record<string, unknown>) => Promise<unknown>
}

function buildBitgetClient(creds: MasterCredentials): BitgetClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => BitgetClient>
  const ExchangeClass = registry.bitget
  if (!ExchangeClass) throw new Error('bitget not found in CCXT registry')
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

export class BitgetProvisioningAdapter implements ProvisioningAdapter {
  readonly exchange = 'bitget' as const
  readonly mode = 'full_api' as const

  private readonly client: BitgetClient
  private readonly subName: string
  private readonly label: string
  private readonly apiPassphrase: string
  private masterUid: string | undefined

  constructor(creds: MasterCredentials, label: string) {
    this.client = buildBitgetClient(creds)
    this.subName = sanitizeBitgetSubName(label)
    this.label = label
    this.apiPassphrase = creds.apiPassphrase ?? ''
  }

  private async getMasterUid(): Promise<string> {
    if (this.masterUid !== undefined) return this.masterUid
    const response = (await this.client.privateSpotGetV2SpotAccountInfo({})) as {
      data?: { userId?: string | number }
    }
    const uid = response.data?.userId
    if (!uid) throw new Error(`Bitget getMasterUid: unexpected response: ${JSON.stringify(response)}`)
    this.masterUid = String(uid)
    return this.masterUid
  }

  async createSubAccount(_label: string): Promise<CreatedSubAccount> {
    // Bitget v2: subAccountList is an array of name strings
    // Note: Bitget API typo — response uses `subaAccountUid` (lowercase 'a'), not `subAccountUid`
    // Note: `data` is `{ successList: [...], failureList: [...] }`, not a direct array
    let response: {
      data?: {
        successList?: { subaAccountUid?: string | number; subAccountUid?: string | number }[]
        failureList?: unknown[]
      }
    }
    try {
      response = (await this.client.privateUserPostV2UserCreateVirtualSubaccount({
        subAccountList: [this.subName],
      })) as typeof response
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('40018')) {
        throw new Error(
          `Bitget createSubAccount: the master API key must have IP binding enabled in Bitget UI ` +
            `(Account → API Keys → edit key → add IP restriction) before virtual sub-accounts can be created. ` +
            `Raw error: ${msg}`
        )
      }
      throw err
    }

    const first = response.data?.successList?.[0]
    const uid = first?.subaAccountUid ?? first?.subAccountUid
    if (!uid) {
      throw new Error(`Bitget createSubAccount: unexpected response — no subAccountUid: ${JSON.stringify(response)}`)
    }
    return { subAccountId: String(uid) }
  }

  async createApiKey(subAccountId: string, ipAllowList: string[]): Promise<CreatedApiKey> {
    // Enable spot + futures products on first provision. margin_trade is NOT a valid value
    // for this endpoint — margin must be enabled manually in the Bitget UI.
    await this.client.privateUserPostV2UserModifyVirtualSubaccount({
      subAccountUid: subAccountId,
      status: 'normal',
      permList: ['read', 'spot_trade', 'contract_trade'],
    })
    const response = (await this.client.privateUserPostV2UserCreateVirtualSubaccountApikey({
      subAccountUid: subAccountId,
      label: `prov-${String(Date.now())}`,
      passphrase: this.apiPassphrase,
      ipList: ipAllowList,
      permType: 'read_and_write',
      permList: this.requiredApiKeyPerms(),
    })) as {
      data?: {
        subAccountApiKey?: string
        apiKey?: string
        secretKey?: string
        passphrase?: string
      }
    }

    // Bitget response uses `subAccountApiKey`, not `apiKey`
    // Passphrase is not returned in the response — fall back to the one we sent
    const apiKey = response.data?.subAccountApiKey ?? response.data?.apiKey
    const apiSecret = response.data?.secretKey
    const apiPassphrase = response.data?.passphrase ?? (this.apiPassphrase || undefined)
    if (!apiKey || !apiSecret) {
      throw new Error(`Bitget createApiKey: unexpected response — missing keys: ${JSON.stringify(response)}`)
    }
    const result: CreatedApiKey = { apiKey, apiSecret }
    if (apiPassphrase) result.apiPassphrase = apiPassphrase
    return result
  }

  private requiredApiKeyPerms(): string[] {
    // margin_trade is NOT accepted by ModifyVirtualSubaccountApikey — include it for
    // CreateVirtualSubaccountApikey only; strip it before any modify call.
    return ['spot_trade', 'contract_trade', 'transfer', 'margin_trade']
  }

  private modifiableApiKeyPerms(): string[] {
    return this.requiredApiKeyPerms().filter(p => p !== 'margin_trade')
  }

  async ensureApiKeyPermissions(
    subAccountId: string,
    apiKey: string,
    apiPassphrase: string | null,
    ipAllowList: string[]
  ): Promise<void> {
    const requiredPerms = this.modifiableApiKeyPerms()
    const keyListResponse = (await this.client.privateUserGetV2UserVirtualSubaccountApikeyList({
      subAccountUid: subAccountId,
    })) as {
      data?: unknown[] | { subAccountApiKeyList?: unknown[]; list?: unknown[] }
    }
    const keyRows = Array.isArray(keyListResponse.data)
      ? keyListResponse.data
      : (keyListResponse.data?.subAccountApiKeyList ?? keyListResponse.data?.list ?? [])
    const current = keyRows.find(row => {
      if (!row || typeof row !== 'object') return false
      const key = (row as Record<string, unknown>).subAccountApiKey ?? (row as Record<string, unknown>).apiKey
      return key === apiKey
    }) as Record<string, unknown> | undefined

    const currentPerms = Array.isArray(current?.permList) ? current.permList.map(String) : []
    const currentIps = Array.isArray(current?.ipList) ? current.ipList.map(String) : []
    const permsMatch = requiredPerms.every(perm => currentPerms.includes(perm))
    const ipsMatch = JSON.stringify([...currentIps].sort()) === JSON.stringify([...ipAllowList].sort())
    if (permsMatch && ipsMatch) return

    const passphrase = apiPassphrase ?? this.apiPassphrase
    if (!passphrase) {
      throw new Error('Bitget ensureApiKeyPermissions: api passphrase is required to modify API key permissions')
    }
    await this.client.privateUserPostV2UserModifyVirtualSubaccountApikey({
      subAccountUid: subAccountId,
      subAccountApiKey: apiKey,
      passphrase,
      label: `prov-${String(Date.now())}`.slice(0, 20),
      ipList: ipAllowList,
      permList: requiredPerms,
    })
  }

  async getSubAccountUsdtBalance(subAccountId: string): Promise<number> {
    const response = (await this.client.privateMixGetV2MixAccountSubAccountAssets({
      subUid: subAccountId,
      productType: 'usdt-futures',
    })) as {
      data?: {
        userId?: string | number
        assetList?: {
          coin?: string
          marginCoin?: string
          available?: string
          frozen?: string
          locked?: string
          accountEquity?: string
          usdtEquity?: string
        }[]
      }[]
    }

    const sub = (response.data ?? []).find(item => scalarString(item.userId) === subAccountId)
    const usdt = (sub?.assetList ?? []).find(a => (a.coin ?? a.marginCoin) === 'USDT')
    if (!usdt) return 0
    const available = parseFloat(usdt.available ?? usdt.accountEquity ?? usdt.usdtEquity ?? '0')
    const frozen = parseFloat(usdt.frozen ?? usdt.locked ?? '0')
    return available + frozen
  }

  async listSubAccounts(): Promise<DiscoveredSubAccount[]> {
    const responses = await Promise.all([
      this.client.privateUserGetV2UserVirtualSubaccountList({ limit: '100', status: 'normal' }),
      this.client.privateUserGetV2UserVirtualSubaccountList({ limit: '100', status: 'freeze' }),
    ])
    const items = responses.flatMap(response => {
      const typed = response as { data?: unknown[] | { list?: unknown[]; subAccountList?: unknown[] } }
      if (Array.isArray(typed.data)) return typed.data
      return typed.data?.subAccountList ?? typed.data?.list ?? []
    })
    return items.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const id = row.subAccountUid ?? row.subaAccountUid ?? row.userId
      if (id === undefined || id === null) return []
      const label = scalarString(row.label ?? row.subAccountName ?? row.subAccount ?? row.username)
      const status = scalarString(row.status ?? row.accountStatus).toLowerCase()
      return [{ subAccountId: scalarString(id), label, frozen: status === 'freeze' || status === 'frozen' }]
    })
  }

  async renameSubAccount(subAccountId: string, _newLabel: string): Promise<void> {
    // No permList here — omitting it leaves existing product permissions unchanged,
    // which preserves margin trading that the user enabled in the Bitget UI.
    await this.client.privateUserPostV2UserModifyVirtualSubaccount({
      subAccountUid: subAccountId,
      status: 'normal',
    })
  }

  async transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void> {
    const masterUid = await this.getMasterUid()
    const isMasterToSub = direction === 'master_to_sub'

    const response = (await this.client.privateSpotPostV2SpotWalletSubaccountTransfer({
      fromType: isMasterToSub ? 'spot' : 'usdt_futures',
      toType: isMasterToSub ? 'usdt_futures' : 'spot',
      fromUserId: isMasterToSub ? masterUid : subAccountId,
      toUserId: isMasterToSub ? subAccountId : masterUid,
      amount: String(amountUsdt),
      coin: 'USDT',
      clientOid: `prov-${String(Date.now())}`,
    })) as { data?: { transferId?: string | number } }

    if (!response.data?.transferId) {
      throw new Error(
        `Bitget transferUsdt (${direction}): unexpected response — no transferId: ${JSON.stringify(response)}`
      )
    }
  }
}
