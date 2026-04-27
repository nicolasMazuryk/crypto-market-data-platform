import { describe, expect, it } from 'vitest'

import type { MarketMetadata } from '../../markets/types.js'
import { computeOrderQty } from './sizing.js'

function makeMarket(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    contractSize: 1,
    pricePrecision: 2,
    amountPrecision: 3,
    makerFee: 0.0002,
    takerFee: 0.0004,
    status: 'trading',
    ...overrides,
  }
}

describe('computeOrderQty', () => {
  it('computes qty as amountUsd / price rounded down to amountPrecision', () => {
    // 20 / 50000 = 0.0004, floor(0.0004 * 10000) / 10000 = 0.0004
    const market = makeMarket({ amountPrecision: 4 })
    const qty = computeOrderQty(20, 50000, 4, market)
    expect(qty).toBe(0.0004)
  })

  it('floors qty rather than rounding', () => {
    const market = makeMarket({ amountPrecision: 2 })
    // 20 / 333 = 0.06006... → floor to 0.06
    const qty = computeOrderQty(20, 333, 4, market)
    expect(qty).toBe(0.06)
  })

  it('returns null when price is zero', () => {
    const market = makeMarket()
    expect(computeOrderQty(20, 0, 4, market)).toBeNull()
  })

  it('returns null when amountUsd is zero', () => {
    const market = makeMarket()
    expect(computeOrderQty(0, 50000, 4, market)).toBeNull()
  })

  it('returns null when qty falls below minAmount', () => {
    // 20 / 1000 = 0.02, but minAmount = 0.05
    const market = makeMarket({ amountPrecision: 3, minAmount: 0.05 })
    expect(computeOrderQty(20, 1000, 4, market)).toBeNull()
  })

  it('returns null when notional falls below minCost', () => {
    // qty = 20/1000 = 0.02, notional = 0.02 * 1000 = 20 < 50
    const market = makeMarket({ amountPrecision: 4, minCost: 50 })
    expect(computeOrderQty(20, 1000, 4, market)).toBeNull()
  })

  it('passes when notional meets minCost exactly', () => {
    // qty = 20/1000 = 0.02, notional = 0.02 * 1000 = 20 = minCost
    const market = makeMarket({ amountPrecision: 4, minCost: 20 })
    const qty = computeOrderQty(20, 1000, 4, market)
    expect(qty).toBe(0.02)
  })

  it('returns null when computed qty is zero after flooring', () => {
    const market = makeMarket({ amountPrecision: 0 })
    // 20 / 50000 = 0.0004, floored to precision 0 (step=1) = 0
    expect(computeOrderQty(20, 50000, 4, market)).toBeNull()
  })

  it('handles tick-size amountPrecision (CCXT TICK_SIZE mode, e.g. 0.001)', () => {
    // Real Binance USDT-M returns precision.amount = 0.001 for BTCUSDT
    // 100 / 77000 ≈ 0.001298 → floor to step 0.001 = 0.001
    const market = makeMarket({ amountPrecision: 0.001, minAmount: 0.001, minCost: 50 })
    const qty = computeOrderQty(100, 77000, 1, market)
    expect(qty).toBe(0.001)
  })

  it('returns null for tick-size when qty below minAmount', () => {
    const market = makeMarket({ amountPrecision: 0.001, minAmount: 0.002, minCost: 50 })
    // 100/77000 ≈ 0.001298 → floors to 0.001, but minAmount = 0.002
    expect(computeOrderQty(100, 77000, 1, market)).toBeNull()
  })
})
