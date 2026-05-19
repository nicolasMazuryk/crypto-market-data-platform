import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('kucoin-api', () => ({
  FuturesClient: vi.fn(),
}))

import { FuturesClient } from 'kucoin-api'
import { createKucoinPuller } from './kucoin.js'

// XBTUSDTM normalises to BTCUSDT (XBT alias + M suffix stripped)
const RAW_SYMBOL = 'XBTUSDTM'
const NORMALIZED_SYMBOL = 'BTCUSDT'

function makeSymbol(
  overrides: Partial<{
    symbol: string
    settleCurrency: string
    expireDate: null | number
    fundingFeeRate: number
    predictedFundingFeeRate: number | undefined | null
    nextFundingRateTime: number
    markPrice: number
  }> = {}
) {
  return {
    symbol: RAW_SYMBOL,
    settleCurrency: 'USDT',
    expireDate: null,
    fundingFeeRate: 0.001,
    predictedFundingFeeRate: -0.0025,
    nextFundingRateTime: Date.now() + 3_600_000,
    markPrice: 65000,
    ...overrides,
  }
}

describe('KuCoin funding puller', () => {
  beforeEach(() => {
    vi.mocked(FuturesClient).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses predictedFundingFeeRate when present', async () => {
    const sym = makeSymbol({ fundingFeeRate: 0.001, predictedFundingFeeRate: -0.0025 })
    vi.mocked(FuturesClient).mockImplementation(
      () =>
        ({
          getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
        }) as never
    )

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap).toBeDefined()
    // Must use predicted rate (-0.0025), not the settled rate (0.001)
    expect(snap?.fundingRate).toBe(-0.0025)
    expect(snap?.fundingRatePercent).toBeCloseTo(-0.25)
  })

  it('populates markPrice from FuturesSymbolInfo', async () => {
    const sym = makeSymbol({ markPrice: 65000 })
    vi.mocked(FuturesClient).mockImplementation(
      () =>
        ({
          getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
        }) as never
    )

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap?.markPrice).toBe(65000)
  })

  it('omits markPrice when FuturesSymbolInfo markPrice is zero', async () => {
    const sym = makeSymbol({ markPrice: 0 })
    vi.mocked(FuturesClient).mockImplementation(
      () =>
        ({
          getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
        }) as never
    )

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap?.markPrice).toBeUndefined()
  })

  it('converts countdown nextFundingRateTime into a future epoch timestamp', async () => {
    vi.setSystemTime(new Date('2026-05-18T12:00:00.000Z'))
    const sym = makeSymbol({ nextFundingRateTime: 21_739_636 })
    vi.mocked(FuturesClient).mockImplementation(
      () =>
        ({
          getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
        }) as never
    )

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap?.nextFundingTimestamp).toBe(new Date('2026-05-18T18:02:00.000Z').getTime())
    expect(snap?.nextFundingDatetime).toBe('2026-05-18T18:02:00.000Z')
  })

  it('stabilizes countdown-derived timestamps across repeated pulls', async () => {
    vi.setSystemTime(new Date('2026-05-18T12:00:00.000Z'))
    const getSymbols = vi
      .fn()
      .mockResolvedValueOnce({ data: [makeSymbol({ nextFundingRateTime: 60_135 })] })
      .mockResolvedValueOnce({ data: [makeSymbol({ nextFundingRateTime: 55_128 })] })
    vi.mocked(FuturesClient).mockImplementation(() => ({ getSymbols }) as never)

    const puller = createKucoinPuller()
    const first = await puller.pull()
    vi.setSystemTime(new Date('2026-05-18T12:00:05.000Z'))
    const second = await puller.pull()

    const firstSnap = first.find(s => s.symbol === NORMALIZED_SYMBOL)
    const secondSnap = second.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(firstSnap?.nextFundingTimestamp).toBe(new Date('2026-05-18T12:01:00.000Z').getTime())
    expect(secondSnap?.nextFundingTimestamp).toBe(firstSnap?.nextFundingTimestamp)
  })

  it('keeps epoch-millisecond nextFundingRateTime unchanged', async () => {
    const epochMs = new Date('2026-05-18T16:00:00.000Z').getTime()
    const sym = makeSymbol({ nextFundingRateTime: epochMs })
    vi.mocked(FuturesClient).mockImplementation(
      () =>
        ({
          getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
        }) as never
    )

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap?.nextFundingTimestamp).toBe(epochMs)
    expect(snap?.nextFundingDatetime).toBe('2026-05-18T16:00:00.000Z')
  })

  it('falls back to fundingFeeRate when predictedFundingFeeRate is missing', async () => {
    const sym = makeSymbol({ fundingFeeRate: 0.001, predictedFundingFeeRate: undefined })
    vi.mocked(FuturesClient).mockImplementation(
      () =>
        ({
          getSymbols: vi.fn().mockResolvedValue({ data: [sym] }),
        }) as never
    )

    const puller = createKucoinPuller()
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap).toBeDefined()
    expect(snap?.fundingRate).toBe(0.001)
    expect(snap?.fundingRatePercent).toBeCloseTo(0.1)
  })
})
