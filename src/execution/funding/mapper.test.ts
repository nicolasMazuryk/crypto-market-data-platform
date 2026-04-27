import { describe, expect, it } from 'vitest'

import type { CcxtFundingRate, CcxtMarket } from '../../exchanges/types.js'
import { mapCcxtFundingRate } from './mapper.js'

function makeMarket(overrides: Partial<CcxtMarket> = {}): CcxtMarket {
  return {
    id: 'BTCUSDT',
    symbol: 'BTC/USDT:USDT',
    swap: true,
    linear: true,
    settle: 'USDT',
    active: true,
    ...overrides,
  }
}

function makeRate(overrides: Partial<CcxtFundingRate> = {}): CcxtFundingRate {
  return {
    symbol: 'BTC/USDT:USDT',
    fundingRate: 0.0001,
    fundingTimestamp: 1_700_000_000_000,
    fundingDatetime: new Date(1_700_000_000_000).toISOString(),
    interval: '8h',
    info: {},
    ...overrides,
  }
}

const markets: Record<string, CcxtMarket> = {
  'BTC/USDT:USDT': makeMarket(),
  'ETH/USDT:USDT': makeMarket({ id: 'ETHUSDT', symbol: 'ETH/USDT:USDT' }),
}

describe('mapCcxtFundingRate', () => {
  it('maps valid binance-style entry to FundingSnapshot', () => {
    const snap = mapCcxtFundingRate('binance', makeRate(), markets)
    expect(snap).not.toBeNull()
    expect(snap?.exchange).toBe('binance')
    expect(snap?.symbol).toBe('BTCUSDT')
    expect(snap?.exchangeSymbol).toBe('BTCUSDT')
    expect(snap?.fundingRate).toBe(0.0001)
    expect(snap?.fundingRatePercent).toBeCloseTo(0.01)
    expect(snap?.fundingInterval).toBe(8)
    expect(snap?.nextFundingTimestamp).toBe(1_700_000_000_000)
    expect(snap?.nextFundingDatetime).toBe(new Date(1_700_000_000_000).toISOString())
    expect(snap?.timestamp).toBeGreaterThan(0)
  })

  it('returns null when fundingRate is missing', () => {
    expect(mapCcxtFundingRate('binance', makeRate({ fundingRate: undefined }), markets)).toBeNull()
  })

  it('returns null when fundingRate is non-finite', () => {
    expect(mapCcxtFundingRate('binance', makeRate({ fundingRate: NaN }), markets)).toBeNull()
    expect(mapCcxtFundingRate('binance', makeRate({ fundingRate: Infinity }), markets)).toBeNull()
  })

  it('returns null when fundingTimestamp is missing', () => {
    expect(mapCcxtFundingRate('binance', makeRate({ fundingTimestamp: undefined }), markets)).toBeNull()
  })

  it('falls back to Binance default interval when unified interval is missing', () => {
    const snap = mapCcxtFundingRate('binance', makeRate({ interval: undefined }), markets)
    expect(snap?.fundingInterval).toBe(8)
  })

  it('returns null when interval is missing for non-Binance exchanges', () => {
    expect(mapCcxtFundingRate('bitget', makeRate({ interval: undefined }), markets)).toBeNull()
  })

  it('returns null when interval is not a recognized value', () => {
    expect(mapCcxtFundingRate('binance', makeRate({ interval: '3h' }), markets)).toBeNull()
    expect(mapCcxtFundingRate('binance', makeRate({ interval: '24h' }), markets)).toBeNull()
    expect(mapCcxtFundingRate('binance', makeRate({ interval: 'daily' }), markets)).toBeNull()
  })

  it('reads interval from exchange info fields when present', () => {
    const snap = mapCcxtFundingRate(
      'bitget',
      makeRate({ interval: undefined, info: { fundingRateInterval: '480' } }),
      markets
    )
    expect(snap?.fundingInterval).toBe(8)
  })

  it('accepts all valid intervals: 1h, 2h, 4h, 8h', () => {
    for (const [interval, expected] of [
      ['1h', 1],
      ['2h', 2],
      ['4h', 4],
      ['8h', 8],
    ] as const) {
      const snap = mapCcxtFundingRate('binance', makeRate({ interval }), markets)
      expect(snap?.fundingInterval).toBe(expected)
    }
  })

  it('returns null when symbol not found in markets', () => {
    const rate = makeRate({ symbol: 'UNKNOWN/USDT:USDT' })
    expect(mapCcxtFundingRate('binance', rate, markets)).toBeNull()
  })

  it('returns null when market is not a USDT-M perp (swap=false)', () => {
    const m = { ...markets, 'BTC/USDT:USDT': makeMarket({ swap: false }) }
    expect(mapCcxtFundingRate('binance', makeRate(), m)).toBeNull()
  })

  it('returns null when market settle is not USDT', () => {
    const m = { ...markets, 'BTC/USDT:USDT': makeMarket({ settle: 'BTC' }) }
    expect(mapCcxtFundingRate('binance', makeRate(), m)).toBeNull()
  })

  it('normalizes OKX-style symbol BTC-USDT-SWAP to BTCUSDT', () => {
    const okxMarkets: Record<string, CcxtMarket> = {
      'BTC/USDT:USDT': makeMarket({ id: 'BTC-USDT-SWAP' }),
    }
    const snap = mapCcxtFundingRate('binance', makeRate(), okxMarkets)
    expect(snap?.symbol).toBe('BTCUSDT')
    expect(snap?.exchangeSymbol).toBe('BTC-USDT-SWAP')
  })

  it('maps bitget exchange correctly', () => {
    const snap = mapCcxtFundingRate('bitget', makeRate(), markets)
    expect(snap?.exchange).toBe('bitget')
  })

  it('populates markPrice from top-level field', () => {
    const snap = mapCcxtFundingRate('binance', makeRate({ markPrice: 50000 }), markets)
    expect(snap?.markPrice).toBe(50000)
  })

  it('populates markPrice from info.markPrice when top-level is absent', () => {
    const snap = mapCcxtFundingRate('binance', makeRate({ info: { markPrice: '47500.5' } }), markets)
    expect(snap?.markPrice).toBeCloseTo(47500.5)
  })

  it('leaves markPrice undefined when not present', () => {
    const snap = mapCcxtFundingRate('binance', makeRate(), markets)
    expect(snap?.markPrice).toBeUndefined()
  })

  it('leaves markPrice undefined when value is zero or non-finite', () => {
    expect(mapCcxtFundingRate('binance', makeRate({ markPrice: 0 }), markets)?.markPrice).toBeUndefined()
    expect(mapCcxtFundingRate('binance', makeRate({ markPrice: NaN }), markets)?.markPrice).toBeUndefined()
  })
})
