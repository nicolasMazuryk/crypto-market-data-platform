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

interface BybitClient {
  privatePostV5UserCreateSubMember: (params: Record<string, unknown>) => Promise<unknown>
  privatePostV5UserCreateSubApi: (params: Record<string, unknown>) => Promise<unknown>
  privatePostV5UserUpdateSubApi: (params: Record<string, unknown>) => Promise<unknown>
  privatePostV5AssetTransferUniversalTransfer: (params: Record<string, unknown>) => Promise<unknown>
  privateGetV5AssetTransferQueryAccountCoinBalance: (params: Record<string, unknown>) => Promise<unknown>
  privateGetV5UserQueryApi: (params: Record<string, unknown>) => Promise<unknown>
  privateGetV5UserQuerySubMembers: (params: Record<string, unknown>) => Promise<unknown>
}

function buildBybitClient(creds: MasterCredentials): BybitClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => BybitClient>
  const ExchangeClass = registry.bybit
  if (!ExchangeClass) throw new Error('bybit not found in CCXT registry')
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

function isUsernameExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /31005|user already exists/i.test(msg)
}

export class BybitProvisioningAdapter implements ProvisioningAdapter {
  readonly exchange = 'bybit' as const
  readonly mode = 'full_api' as const

  private readonly client: BybitClient
  private masterUid: number | undefined

  constructor(creds: MasterCredentials) {
    this.client = buildBybitClient(creds)
  }

  private async getMasterUid(): Promise<number> {
    if (this.masterUid !== undefined) return this.masterUid
    const response = (await this.client.privateGetV5UserQueryApi({})) as {
      result?: { userID?: number | string; uid?: number | string }
    }
    const uid = response.result?.userID ?? response.result?.uid
    if (!uid) throw new Error(`Bybit getMasterUid: unexpected response: ${JSON.stringify(response)}`)
    this.masterUid = Number(uid)
    return this.masterUid
  }

  async createSubAccount(label: string): Promise<CreatedSubAccount> {
    const username = label.replace(/[^a-zA-Z0-9]/g, '')
    const fallback = `${username.slice(0, 12)}${Date.now().toString(36).slice(-4)}`
    const usernames = Array.from(new Set([username, fallback]))
    let response: { result?: { uid?: string | number } } | undefined
    let createdUsername = username
    for (const candidate of usernames) {
      try {
        response = (await this.client.privatePostV5UserCreateSubMember({
          username: candidate,
          memberType: 1,
          note: label,
        })) as { result?: { uid?: string | number } }
        createdUsername = candidate
        break
      } catch (err) {
        if (candidate !== usernames.at(-1) && isUsernameExistsError(err)) {
          await new Promise(resolve => setTimeout(resolve, 1200))
          continue
        }
        throw err
      }
    }

    const uid = response?.result?.uid
    if (!uid) {
      throw new Error(`Bybit createSubAccount: unexpected response — no uid: ${JSON.stringify(response)}`)
    }
    return { subAccountId: String(uid), subAccountLabel: createdUsername }
  }

  async createApiKey(subAccountId: string, ipAllowList: string[]): Promise<CreatedApiKey> {
    const response = (await this.client.privatePostV5UserCreateSubApi({
      subuid: Number(subAccountId),
      note: `prov-${String(Date.now())}`,
      readOnly: 0,
      ips: ipAllowList.join(','),
      permissions: {
        ContractTrade: ['Order', 'Position'],
        Spot: ['SpotTrade'],
        Wallet: ['AccountTransfer', 'SubMemberTransferList'],
        Options: ['OptionsTrade'],
        Exchange: ['ExchangeHistory'],
      },
    })) as { result?: { apiKey?: string; secret?: string } }

    const apiKey = response.result?.apiKey
    const apiSecret = response.result?.secret
    if (!apiKey || !apiSecret) {
      throw new Error(`Bybit createApiKey: unexpected response — missing apiKey/secret: ${JSON.stringify(response)}`)
    }
    return { apiKey, apiSecret }
  }

  async listSubAccounts(): Promise<DiscoveredSubAccount[]> {
    const response = (await this.client.privateGetV5UserQuerySubMembers({})) as {
      result?: { subMembers?: unknown[]; members?: unknown[]; list?: unknown[] }
    }
    const items = response.result?.subMembers ?? response.result?.members ?? response.result?.list ?? []
    return items.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const id = row.uid ?? row.subuid ?? row.subUid ?? row.memberId
      if (id === undefined || id === null) return []
      const label = scalarString(row.username ?? row.memberName ?? row.note)
      const frozen = row.status === 0 || row.status === '0' || row.frozen === 1 || row.frozen === '1'
      return [{ subAccountId: scalarString(id), label, frozen }]
    })
  }

  renameSubAccount(_subAccountId: string, _newLabel: string): Promise<void> {
    return Promise.reject(new Error('RenameNotSupported: Bybit does not expose sub-account rename via API'))
  }

  async getSubAccountUsdtBalance(subAccountId: string): Promise<number> {
    const response = (await this.client.privateGetV5AssetTransferQueryAccountCoinBalance({
      memberId: Number(subAccountId),
      accountType: 'UNIFIED',
      coin: 'USDT',
    })) as { result?: { balance?: { walletBalance?: string; transferBalance?: string } } }

    const raw = response.result?.balance?.transferBalance ?? response.result?.balance?.walletBalance
    if (raw === undefined) {
      throw new Error(`Bybit getSubAccountUsdtBalance: unexpected response: ${JSON.stringify(response)}`)
    }
    return parseFloat(raw)
  }

  async transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void> {
    const masterUid = await this.getMasterUid()
    const subUid = Number(subAccountId)
    const isMasterToSub = direction === 'master_to_sub'
    const params: Record<string, unknown> = {
      transferId: randomUUID(),
      coin: 'USDT',
      amount: String(amountUsdt),
      fromAccountType: isMasterToSub ? 'FUND' : 'UNIFIED',
      toAccountType: isMasterToSub ? 'UNIFIED' : 'FUND',
      fromMemberId: isMasterToSub ? masterUid : subUid,
      toMemberId: isMasterToSub ? subUid : masterUid,
    }

    const response = (await this.client.privatePostV5AssetTransferUniversalTransfer(params)) as {
      retCode?: number
      retMsg?: string
    }

    if (typeof response.retCode === 'number' && response.retCode !== 0) {
      throw new Error(`Bybit transferUsdt (${direction}) failed: ${response.retMsg ?? JSON.stringify(response)}`)
    }
  }
}
