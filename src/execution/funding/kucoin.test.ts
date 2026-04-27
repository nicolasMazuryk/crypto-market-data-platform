import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('kucoin-api', () => ({
  FuturesClient: vi.fn(),
}))

import { FuturesClient } from 'kucoin-api'
import { createKucoinPuller } from './kucoin.js'

// XBTUSDTM normalises to BTCUSDT (XBT alias + M suffix stripped)
const RAW_SYMBOL = 'XBTUSDTM'
const NORMALIZED_SYMBOL = 'BTCUSDT'

function makeSymbol(overrides: Partial<{
  symbol: string
  settleCurrency: string
  expireDate: null | number
  fundingFeeRate: number
  predictedFundingFeeRate: number | undefined | null
  nextFundingRateTime: number
}> = {}) {
  return {
    symbol: RAW_SYMBOL,
    settleCurrency: 'USDT',
    expireDate: null,
    fundingFeeRate: 0.001,
    predictedFundingFeeRate: -0.0025,
    nextFundingRateTime: Date.now() + 3_600_000,
    ...overrides,
  }
}

describe('KuCoin funding puller', () => {
  beforeEach(() => {
    vi.mocked(FuturesClient).mockReset()
  })

  it('uses predictedFundingFeeRate when present', async () => {
    const sym = makeSymbol({ fundingFeeRate: 0.001, predictedFundingFeeRate: -0.0025 })
    vi.mocked(FuturesClient).mockImplementation(() => ({
      getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
    }) as never)

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap).toBeDefined()
    // Must use predicted rate (-0.0025), not the settled rate (0.001)
    expect(snap?.fundingRate).toBe(-0.0025)
    expect(snap?.fundingRatePercent).toBeCloseTo(-0.25)
  })

  it('defaults to 0 and still emits the snapshot when predictedFundingFeeRate is missing', async () => {
    const sym = makeSymbol({ fundingFeeRate: 0.001, predictedFundingFeeRate: undefined })
    vi.mocked(FuturesClient).mockImplementation(() => ({
      getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
    }) as never)

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    // Snapshot is still emitted (not filtered out)
    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap).toBeDefined()
    // Rate defaults to 0 — falling back to fundingFeeRate would reintroduce the bug
    expect(snap?.fundingRate).toBe(0)
  })
})
