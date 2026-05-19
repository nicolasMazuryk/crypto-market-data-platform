import { describe, expect, it } from 'vitest'

import { createIds } from '../core/ids.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'
import { createStrategy1Rule } from './strategy_1.js'
import type { EvalContext, Strategy1Config } from './types.js'

function makeSnapshot(overrides: Partial<FundingSnapshot> = {}): FundingSnapshot {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    fundingRate: -0.005,
    fundingRatePercent: -0.5,
    fundingInterval: 8,
    nextFundingTimestamp: 1_700_000_000_000,
    nextFundingDatetime: new Date(1_700_000_000_000).toISOString(),
    timestamp: 1_699_999_900_000,
    markPrice: 1000,
    ...overrides,
  }
}

function makeMarket(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    contractSize: 1,
    pricePrecision: 2,
    amountPrecision: 0.001,
    minAmount: 0.001,
    makerFee: 0.0002,
    takerFee: 0.0004,
    status: 'trading',
    ...overrides,
  }
}

const BASE_CONFIG: Strategy1Config = {
  id: 'strategy_1',
  enabled: true,
  negativeFundingThresholdPercent: -0.5,
  entryOffsetSeconds: 10,
  exitOffsetSeconds: 2,
  amountUsd: 10,
  leverage: 5,
}

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  const snap = makeSnapshot()
  return {
    now: 1_699_999_900_000,
    exchange: 'binance',
    fundingEvent: {
      symbol: 'BTCUSDT',
      nextFundingTimestamp: snap.nextFundingTimestamp,
      fundingInterval: 8,
    },
    snapshots: new Map([['BTCUSDT', snap]]),
    markets: () => makeMarket(),
    config: BASE_CONFIG,
    ...overrides,
  }
}

describe('createStrategy1Rule', () => {
  const ids = createIds()
  const rule = createStrategy1Rule({ ids, refPrice: () => 1000 })

  it('returns intent when threshold met', () => {
    const intents = rule.evaluate(makeCtx())
    expect(intents).toHaveLength(1)
    const [intent] = intents
    expect(intent?.strategy).toBe('strategy_1')
    expect(intent?.side).toBe('long')
    expect(intent?.exchange).toBe('binance')
    expect(intent?.symbol).toBe('BTCUSDT')
    expect(intent?.amountUsd).toBe(10)
    expect(intent?.leverage).toBe(5)
    expect(intent?.entryAt).toBe(1_700_000_000_000 - 10_000)
    expect(intent?.exitPolicy).toEqual({ kind: 'timed', exitAt: 1_700_000_000_000 + 2_000 })
    expect(intent?.volume).toBeGreaterThan(0)
  })

  it('returns empty when funding rate above threshold (-0.4 > -0.5)', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.4 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('passes at exactly the threshold (-0.5 <= -0.5)', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.5 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(1)
  })

  it('returns empty when config id is not strategy_1', () => {
    const ctx = makeCtx({ config: { id: 'strategy_3a', enabled: true } as never })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('returns empty when snapshot is missing', () => {
    const ctx = makeCtx({ snapshots: new Map() })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('returns empty when market is missing', () => {
    const ctx = makeCtx({ markets: () => undefined })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('returns empty when market is not trading', () => {
    const ctx = makeCtx({ markets: () => makeMarket({ status: 'halted' }) })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('returns empty when refPrice is undefined', () => {
    const ruleNoPrice = createStrategy1Rule({ ids, refPrice: () => undefined })
    expect(ruleNoPrice.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when qty computation fails (price too high for amountUsd)', () => {
    // price=50000, amountUsd=10 → rawQty=0.0002 < step(0.001) → qty=0 → null
    const ruleHighPrice = createStrategy1Rule({ ids, refPrice: () => 50000 })
    expect(ruleHighPrice.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when minCost too high', () => {
    const ctx = makeCtx({ markets: () => makeMarket({ minCost: 100_000 }) })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('produces deterministic intent id for same key', () => {
    const [a] = rule.evaluate(makeCtx())
    const [b] = rule.evaluate(makeCtx())
    expect(a?.id).toBeDefined()
    expect(a?.id).toBe(b?.id)
  })

  it('produces different intent id for different nextFundingTimestamp', () => {
    const snap2 = makeSnapshot({ nextFundingTimestamp: 1_700_000_008_000 })
    const ctx2 = makeCtx({
      fundingEvent: { symbol: 'BTCUSDT', nextFundingTimestamp: 1_700_000_008_000, fundingInterval: 8 },
      snapshots: new Map([['BTCUSDT', snap2]]),
    })
    const [a] = rule.evaluate(makeCtx())
    const [b] = rule.evaluate(ctx2)
    expect(a?.id).not.toBe(b?.id)
  })
})
