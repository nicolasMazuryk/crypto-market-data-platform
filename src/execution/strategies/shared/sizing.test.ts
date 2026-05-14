import { describe, expect, it } from 'vitest'

import type { MarketMetadata } from '../../markets/types.js'
import { computeOrderQty, lotStep } from './sizing.js'

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
    // 20 / 50000 = 0.0004, floor(0.0004 / 0.0001) * 0.0001 = 0.0004
    const market = makeMarket({ amountPrecision: 0.0001 })
    const qty = computeOrderQty(20, 50000, 4, market)
    expect(qty).toBe(0.0004)
  })

  it('floors qty rather than rounding', () => {
    const market = makeMarket({ amountPrecision: 0.01 })
    // 20 / 333 = 0.06006... → floor to step 0.01 = 0.06
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
    const market = makeMarket({ amountPrecision: 0.001, minAmount: 0.05 })
    expect(computeOrderQty(20, 1000, 4, market)).toBeNull()
  })

  it('returns null when notional falls below minCost', () => {
    // qty = 20/1000 = 0.02, notional = 0.02 * 1000 = 20 < 50
    const market = makeMarket({ amountPrecision: 0.0001, minCost: 50 })
    expect(computeOrderQty(20, 1000, 4, market)).toBeNull()
  })

  it('passes when notional meets minCost exactly', () => {
    // qty = 20/1000 = 0.02, notional = 0.02 * 1000 = 20 = minCost
    const market = makeMarket({ amountPrecision: 0.0001, minCost: 20 })
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

  it('treats amountPrecision >= 1 as direct lot step (CCXT precisionMode 4)', () => {
    // Bybit GIGA has precision.amount = 10 (step = 10 contracts)
    const market = makeMarket({ amountPrecision: 10, minAmount: 10 })
    const qty = computeOrderQty(20, 0.006215, 4, market)
    // rawQty = 20 / 0.006215 ≈ 3218.02 → floor to step 10 = 3210
    expect(qty).toBe(3210)
  })

  it('clamps qty to maxAmount when computed qty exceeds exchange limit', () => {
    // $20 / $0.0008 = 25000 contracts, but maxAmount = 500
    const market = makeMarket({ amountPrecision: 1, maxAmount: 500 })
    const qty = computeOrderQty(20, 0.0008, 4, market)
    expect(qty).toBe(500)
  })

  it('returns null when clamped qty falls below minAmount', () => {
    // maxAmount clamps qty to 5, but minAmount = 10
    const market = makeMarket({ amountPrecision: 1, maxAmount: 5, minAmount: 10 })
    expect(computeOrderQty(20, 0.0001, 4, market)).toBeNull()
  })
})

describe('lotStep', () => {
  it('returns precision directly when > 0 (CCXT precisionMode 4 tick size)', () => {
    expect(lotStep(3)).toBe(3)
    expect(lotStep(10)).toBe(10)
    expect(lotStep(0.001)).toBe(0.001)
    expect(lotStep(1)).toBe(1)
  })

  it('returns 1 when precision is 0 or negative', () => {
    expect(lotStep(0)).toBe(1)
    expect(lotStep(-1)).toBe(1)
  })
})
