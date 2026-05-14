import { describe, it, expect, vi } from 'vitest'

import { BitgetProvisioningAdapter } from './bitget.js'
import { BybitProvisioningAdapter } from './bybit.js'
import { KucoinProvisioningAdapter } from './kucoin.js'
import { MexcProvisioningAdapter } from './mexc.js'
import { reconcileCapital } from './reconcile.js'
import { loadMasterCredentials, type ProvisioningAdapter } from './types.js'

const fakeCreds = { apiKey: 'key', apiSecret: 'secret', apiPassphrase: 'pass' }

describe('full_api adapters — reuse conformance', () => {
  const cases: [string, ProvisioningAdapter][] = [
    ['bitget', new BitgetProvisioningAdapter(fakeCreds, 'test-label')],
    ['bybit', new BybitProvisioningAdapter(fakeCreds)],
    ['kucoin', new KucoinProvisioningAdapter(fakeCreds, 'test-label')],
    ['mexc', new MexcProvisioningAdapter(fakeCreds)],
  ]

  it.each(cases)('%s implements listSubAccounts', (_name, adapter) => {
    expect(typeof adapter.listSubAccounts).toBe('function')
  })

  it.each(cases)('%s implements renameSubAccount', (_name, adapter) => {
    expect(typeof adapter.renameSubAccount).toBe('function')
  })
})

function makeAdapter(balance: number): ProvisioningAdapter & {
  transferUsdt: ReturnType<typeof vi.fn>
} {
  const transferUsdt = vi.fn().mockResolvedValue(undefined)
  return {
    exchange: 'bybit',
    mode: 'full_api',
    createSubAccount: vi.fn(),
    createApiKey: vi.fn(),
    getSubAccountUsdtBalance: vi.fn().mockResolvedValue(balance),
    transferUsdt,
    listSubAccounts: vi.fn(),
    renameSubAccount: vi.fn(),
  } as unknown as ProvisioningAdapter & { transferUsdt: ReturnType<typeof vi.fn> }
}

describe('reconcileCapital', () => {
  it('tops up master → sub when balance is below target', async () => {
    const adapter = makeAdapter(50)
    const result = await reconcileCapital(adapter, '123', 200)

    expect(result).toEqual({ before: 50, after: 200, transferred: 150, direction: 'master_to_sub' })
    expect(adapter.transferUsdt).toHaveBeenCalledWith('123', 150, 'master_to_sub')
  })

  it('withdraws sub → master when balance exceeds target', async () => {
    const adapter = makeAdapter(300)
    const result = await reconcileCapital(adapter, '123', 200)

    expect(result).toEqual({ before: 300, after: 200, transferred: 100, direction: 'sub_to_master' })
    expect(adapter.transferUsdt).toHaveBeenCalledWith('123', 100, 'sub_to_master')
  })

  it('skips transfer when balance is already at target', async () => {
    const adapter = makeAdapter(200)
    const result = await reconcileCapital(adapter, '123', 200)

    expect(result).toEqual({ before: 200, after: 200, transferred: 0, direction: 'none' })
    expect(adapter.transferUsdt).not.toHaveBeenCalled()
  })

  it('skips transfer when delta is below the dust epsilon', async () => {
    const adapter = makeAdapter(199.999)
    const result = await reconcileCapital(adapter, '123', 200)

    expect(result.direction).toBe('none')
    expect(adapter.transferUsdt).not.toHaveBeenCalled()
  })

  it('uses assumed current balance when provided', async () => {
    const adapter = makeAdapter(0)
    const result = await reconcileCapital(adapter, '123', 200, { assumedCurrentBalance: 175 })

    expect(result).toEqual({ before: 175, after: 200, transferred: 25, direction: 'master_to_sub' })
    expect(adapter.getSubAccountUsdtBalance).not.toHaveBeenCalled()
    expect(adapter.transferUsdt).toHaveBeenCalledWith('123', 25, 'master_to_sub')
  })
})

describe('loadMasterCredentials', () => {
  it('prefers MASTER_ credentials', () => {
    const creds = loadMasterCredentials('binance', {
      MASTER_BINANCE_API_KEY: 'master-key',
      MASTER_BINANCE_API_SECRET: 'master-secret',
      BINANCE_API_KEY: 'exchange-key',
      BINANCE_API_SECRET: 'exchange-secret',
    })

    expect(creds).toEqual({ apiKey: 'master-key', apiSecret: 'master-secret' })
  })

  it('falls back to exchange credentials for master account API keys', () => {
    const creds = loadMasterCredentials('okx', {
      OKX_API_KEY: 'key',
      OKX_API_SECRET: 'secret',
      OKX_API_PASSPHRASE: 'pass',
    })

    expect(creds).toEqual({ apiKey: 'key', apiSecret: 'secret', apiPassphrase: 'pass' })
  })
})
