import { describe, expect, it } from 'vitest'

import type { MarketMetadata } from '../../markets/types.js'
import { alignToLotStep, computeOrderQty, lotStep, meetsMinNotional } from './sizing.js'

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
    // 10 / 50000 = 0.0002, floor(0.0002 / 0.0001) * 0.0001 = 0.0002
    const market = makeMarket({ amountPrecision: 0.0001 })
    const qty = computeOrderQty(10, 50000, 4, market)
    expect(qty).toBe(0.0002)
  })

  it('floors qty rather than rounding', () => {
    const market = makeMarket({ amountPrecision: 0.01 })
    // 10 / 333 = 0.03003... → floor to step 0.01 = 0.03
    const qty = computeOrderQty(10, 333, 4, market)
    expect(qty).toBe(0.03)
  })

  it('returns null when price is zero', () => {
    const market = makeMarket()
    expect(computeOrderQty(10, 0, 4, market)).toBeNull()
  })

  it('returns null when amountUsd is zero', () => {
    const market = makeMarket()
    expect(computeOrderQty(0, 50000, 4, market)).toBeNull()
  })

  it('returns null when qty falls below minAmount', () => {
    // 10 / 1000 = 0.01, but minAmount = 0.05
    const market = makeMarket({ amountPrecision: 0.001, minAmount: 0.05 })
    expect(computeOrderQty(10, 1000, 4, market)).toBeNull()
  })

  it('returns null when notional falls below minCost', () => {
    // qty = 10/1000 = 0.01, notional = 0.01 * 1000 = 10 < 50
    const market = makeMarket({ amountPrecision: 0.0001, minCost: 50 })
    expect(computeOrderQty(10, 1000, 4, market)).toBeNull()
  })

  it('passes when notional meets minCost exactly', () => {
    // qty = 10/1000 = 0.01, notional = 0.01 * 1000 = 10 = minCost
    const market = makeMarket({ amountPrecision: 0.0001, minCost: 10 })
    const qty = computeOrderQty(10, 1000, 4, market)
    expect(qty).toBe(0.01)
  })

  it('returns null when computed qty is zero after flooring', () => {
    const market = makeMarket({ amountPrecision: 0 })
    // 10 / 50000 = 0.0002, floored to precision 0 (step=1) = 0
    expect(computeOrderQty(10, 50000, 4, market)).toBeNull()
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
    const qty = computeOrderQty(10, 0.006215, 4, market)
    // rawQty = 10 / 0.006215 ≈ 1609.01 → floor to step 10 = 1600
    expect(qty).toBe(1600)
  })

  it('clamps qty to maxAmount when computed qty exceeds exchange limit', () => {
    // $10 / $0.0008 = 12500 contracts, but maxAmount = 500
    const market = makeMarket({ amountPrecision: 1, maxAmount: 500 })
    const qty = computeOrderQty(10, 0.0008, 4, market)
    expect(qty).toBe(500)
  })

  it('returns null when clamped qty falls below minAmount', () => {
    // maxAmount clamps qty to 5, but minAmount = 10
    const market = makeMarket({ amountPrecision: 1, maxAmount: 5, minAmount: 10 })
    expect(computeOrderQty(10, 0.0001, 4, market)).toBeNull()
  })
})

describe('computeOrderQty — float precision', () => {
  it('returns clean float without IEEE 754 artifact (132 * 0.1 = 13.200000000000001 without fix)', () => {
    // Confirm artifact exists in raw JS
    expect(String(132 * 0.1)).toBe('13.200000000000001')
    // computeOrderQty should produce clean 13.2 via toFixed-based rounding
    const market = makeMarket({ amountPrecision: 0.1, minAmount: 0.1 })
    // amountUsd=1320, price=100, step=0.1 → rawQty=13.2 → count=132 via float
    // Without fix: 132*0.1 = 13.200000000000001; with fix: toFixed(1) → 13.2
    const qty = computeOrderQty(1320, 100, 1, market)
    expect(qty).not.toBeNull()
    expect(String(qty)).not.toBe('13.200000000000001')
  })

  it('returns clean float for step 0.001', () => {
    const market = makeMarket({ amountPrecision: 0.001 })
    // 100 / 77 = 1.2987... → floor to step 0.001 = 1.298
    const qty = computeOrderQty(100, 77, 1, market)
    expect(qty).toBe(1.298)
    expect(String(qty)).not.toMatch(/000000/)
  })
})

describe('alignToLotStep', () => {
  it('floors fractional-step rung qty to lot step (ladder path fix)', () => {
    // Old code: Math.round(10 * (1/3) * 1e8) / 1e8 = 3.33333333 (not on step=1 boundary)
    // alignToLotStep correctly floors to 3
    const market = makeMarket({ amountPrecision: 1 })
    expect(alignToLotStep(10 * (1 / 3), market)).toBe(3)
  })

  it('removes IEEE 754 artifact from prior multiplication (e.g. 132 * 0.1)', () => {
    // 132 * 0.1 = 13.200000000000001 in JS; aligning to step 0.1 cleans it
    const market = makeMarket({ amountPrecision: 0.1 })
    const withArtifact = 132 * 0.1
    expect(String(withArtifact)).toBe('13.200000000000001')
    const aligned = alignToLotStep(withArtifact, market)
    expect(aligned).toBe(13.2)
    expect(String(aligned)).toBe('13.2')
  })

  it('floors to the step boundary', () => {
    const market = makeMarket({ amountPrecision: 10 })
    expect(alignToLotStep(37, market)).toBe(30)
  })

  it('works for integer step 1', () => {
    const market = makeMarket({ amountPrecision: 1 })
    expect(alignToLotStep(5.9, market)).toBe(5)
  })
})

describe('meetsMinNotional', () => {
  it('returns true when market has no minCost', () => {
    const market = makeMarket()
    expect(meetsMinNotional(1, 0.5, market)).toBe(true)
  })

  it('returns false when qty * price < minCost', () => {
    const market = makeMarket({ minCost: 5 })
    expect(meetsMinNotional(1, 0.5, market)).toBe(false)
  })

  it('returns true when qty * price >= minCost', () => {
    const market = makeMarket({ minCost: 5 })
    expect(meetsMinNotional(10, 0.5, market)).toBe(true)
  })

  it('returns true when notional equals minCost exactly', () => {
    const market = makeMarket({ minCost: 5 })
    expect(meetsMinNotional(10, 0.5, market)).toBe(true)
  })

  it('accounts for contractSize', () => {
    // qty=1 contract, contractSize=10 BTC/contract, price=$50k → notional=$500k
    const market = makeMarket({ contractSize: 10, minCost: 100 })
    expect(meetsMinNotional(1, 50000, market)).toBe(true)
    // qty=1 contract, contractSize=0.001 BTC/contract, price=$50k → notional=$50
    const smallContract = makeMarket({ contractSize: 0.001, minCost: 100 })
    expect(meetsMinNotional(1, 50000, smallContract)).toBe(false)
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
