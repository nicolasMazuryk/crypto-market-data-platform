import ccxt from 'ccxt'

import type {
  CreatedApiKey,
  CreatedSubAccount,
  DiscoveredSubAccount,
  MasterCredentials,
  ProvisioningAdapter,
  TransferDirection,
} from './types.js'

interface BinanceClient {
  privateGetAccount: (params: Record<string, unknown>) => Promise<unknown>
  sapiGetSubAccountList: (params: Record<string, unknown>) => Promise<unknown>
  sapiPostSubAccountVirtualSubAccount: (params: Record<string, unknown>) => Promise<unknown>
  sapiPostSubAccountFuturesEnable: (params: Record<string, unknown>) => Promise<unknown>
  sapiGetSubAccountFuturesAccount: (params: Record<string, unknown>) => Promise<unknown>
  sapiPostSubAccountUniversalTransfer: (params: Record<string, unknown>) => Promise<unknown>
  sapiPostAssetTransfer: (params: Record<string, unknown>) => Promise<unknown>
  sapiPostAssetGetFundingAsset: (params: Record<string, unknown>) => Promise<unknown>
}

function buildBinanceClient(creds: MasterCredentials): BinanceClient {
  const registry = ccxt as unknown as Record<string, new (cfg: Record<string, unknown>) => BinanceClient>
  const ExchangeClass = registry.binance
  if (!ExchangeClass) throw new Error('binance not found in CCXT registry')
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class BinanceProvisioningAdapter implements ProvisioningAdapter {
  readonly exchange = 'binance' as const
  readonly mode = 'full_api' as const

  private readonly client: BinanceClient

  constructor(creds: MasterCredentials) {
    this.client = buildBinanceClient(creds)
  }

  async createSubAccount(label: string): Promise<CreatedSubAccount> {
    const subAccountString = label
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 20)
      .toLowerCase()
    const response = (await this.client.sapiPostSubAccountVirtualSubAccount({ subAccountString })) as {
      email?: string
    }
    if (!response.email) {
      throw new Error(`Binance standard createSubAccount: unexpected response: ${JSON.stringify(response)}`)
    }
    try {
      await this.client.sapiPostSubAccountFuturesEnable({ email: response.email })
    } catch {
      // Futures may already be enabled or unavailable for this sub-account; readiness verification catches it.
    }
    return { subAccountId: response.email }
  }

  createApiKey(_subAccountId: string, _ipAllowList: string[]): Promise<CreatedApiKey> {
    return Promise.reject(
      new Error('ManualApiKeyRequired: Binance standard sub-account API does not expose API-key secret creation')
    )
  }

  async listSubAccounts(): Promise<DiscoveredSubAccount[]> {
    const response = (await this.client.sapiGetSubAccountList({})) as { subAccounts?: unknown[] }
    return (response.subAccounts ?? []).flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const email = row.email
      if (typeof email !== 'string') return []
      if (!email.includes('_virtual@')) return []
      return [{ subAccountId: email, label: scalarString(row.remark) || email, frozen: row.isFreeze === true }]
    })
  }

  renameSubAccount(_subAccountId: string, _newLabel: string): Promise<void> {
    return Promise.reject(
      new Error('RenameNotSupported: Binance standard sub-account API does not expose sub-account rename')
    )
  }

  async getSubAccountUsdtBalance(subAccountId: string): Promise<number> {
    const response = (await this.client.sapiGetSubAccountFuturesAccount({ email: subAccountId })) as {
      totalWalletBalance?: string
      totalMarginBalance?: string
      assets?: { asset?: string; walletBalance?: string; marginBalance?: string }[]
    }
    const usdt = (response.assets ?? []).find(asset => asset.asset === 'USDT')
    return parseFloat(
      usdt?.walletBalance ?? usdt?.marginBalance ?? response.totalWalletBalance ?? response.totalMarginBalance ?? '0'
    )
  }

  async transferUsdt(subAccountId: string, amountUsdt: number, direction: TransferDirection): Promise<void> {
    const isMasterToSub = direction === 'master_to_sub'
    if (!isMasterToSub) {
      await this.transferSpotAndFutures(subAccountId, amountUsdt, false)
      await this.transferSpotToFunding(amountUsdt)
      return
    }

    const spotBalanceBefore = await this.getMasterSpotUsdtBalance()
    await this.transferFundingToSpot(amountUsdt)
    await this.waitForMasterSpotBalance(spotBalanceBefore + amountUsdt)
    await this.transferSpotAndFuturesWithRetry(subAccountId, amountUsdt)
  }

  private async transferSpotAndFutures(
    subAccountId: string,
    amountUsdt: number,
    isMasterToSub: boolean
  ): Promise<void> {
    await this.client.sapiPostSubAccountUniversalTransfer({
      fromEmail: isMasterToSub ? undefined : subAccountId,
      toEmail: isMasterToSub ? subAccountId : undefined,
      fromAccountType: isMasterToSub ? 'SPOT' : 'USDT_FUTURE',
      toAccountType: isMasterToSub ? 'USDT_FUTURE' : 'SPOT',
      asset: 'USDT',
      amount: String(amountUsdt),
    })
  }

  private isNoMasterSpotAssetError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /user have no asset/i.test(msg)
  }

  private async transferSpotAndFuturesWithRetry(subAccountId: string, amountUsdt: number): Promise<void> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.transferSpotAndFutures(subAccountId, amountUsdt, true)
        return
      } catch (err) {
        if (!this.isNoMasterSpotAssetError(err)) throw err
        lastErr = err
        await sleep(500 * (attempt + 1))
      }
    }
    throw lastErr
  }

  private async transferFundingToSpot(amountUsdt: number): Promise<void> {
    const fundingBalance = await this.getMasterFundingUsdtBalance()
    if (fundingBalance + 0.00000001 < amountUsdt) {
      throw new Error(
        `Binance master funding USDT balance ${fundingBalance.toFixed(8)} is below required ${amountUsdt.toFixed(8)}`
      )
    }
    await this.client.sapiPostAssetTransfer({
      type: 'FUNDING_MAIN',
      asset: 'USDT',
      amount: String(amountUsdt),
    })
  }

  private async transferSpotToFunding(amountUsdt: number): Promise<void> {
    await this.client.sapiPostAssetTransfer({
      type: 'MAIN_FUNDING',
      asset: 'USDT',
      amount: String(amountUsdt),
    })
  }

  private async waitForMasterSpotBalance(requiredUsdt: number): Promise<void> {
    let lastBalance = 0
    for (let attempt = 0; attempt < 10; attempt++) {
      lastBalance = await this.getMasterSpotUsdtBalance()
      if (lastBalance + 0.00000001 >= requiredUsdt) return
      await sleep(500 * (attempt + 1))
    }
    throw new Error(
      `Binance funding-to-spot transfer did not become visible in spot balance; ` +
        `spot=${lastBalance.toFixed(8)}, required=${requiredUsdt.toFixed(8)}`
    )
  }

  private async getMasterSpotUsdtBalance(): Promise<number> {
    const response = (await this.client.privateGetAccount({})) as {
      balances?: { asset?: string; free?: string }[]
    }
    const usdt = (response.balances ?? []).find(asset => asset.asset === 'USDT')
    return parseFloat(usdt?.free ?? '0')
  }

  private async getMasterFundingUsdtBalance(): Promise<number> {
    const response = (await this.client.sapiPostAssetGetFundingAsset({
      asset: 'USDT',
      needBtcValuation: 'false',
    })) as { asset?: string; free?: string }[]
    const usdt = response.find(asset => asset.asset === 'USDT')
    return parseFloat(usdt?.free ?? '0')
  }
}
