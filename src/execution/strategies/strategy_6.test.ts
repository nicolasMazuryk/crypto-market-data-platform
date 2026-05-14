import { describe, expect, it } from 'vitest'

import { createIds } from '../core/ids.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'
import { createStrategy6Rule } from './strategy_6.js'
import type { EvalContext, Strategy6Config } from './types.js'

function makeSnapshot(overrides: Partial<FundingSnapshot> = {}): FundingSnapshot {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    fundingRate: -0.006,
    fundingRatePercent: -0.6,
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

const BASE_CONFIG: Strategy6Config = {
  id: 'strategy_6',
  enabled: true,
  mainSide: 'long',
  funding_threshold: 0,
  entryOffsetSeconds: 10,
  fundingFeeTimeoutSeconds: 8,
  tpMultiplier: 0.5,
  slMultiplier: 1.0,
  deadlineSeconds: 3300,
  mainAmountUsd: 20,
  leverage: 4,
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

describe('createStrategy6Rule', () => {
  const ids = createIds()
  const rule = createStrategy6Rule({ ids, refPrice: () => 1000 })

  it('returns intent when threshold met (always-on by default)', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.strategy).toBe('strategy_6')
    expect(intent?.side).toBe('long')
    expect(intent?.exchange).toBe('binance')
    expect(intent?.symbol).toBe('BTCUSDT')
    expect(intent?.amountUsd).toBe(20)
    expect(intent?.leverage).toBe(4)
    expect(intent?.volume).toBeGreaterThan(0)
    expect(intent?.entryAt).toBe(1_700_000_000_000 - 10_000)
  })

  it('fires for negative funding rate', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.6 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(1)
  })

  it('always-on when threshold = 0 (fires for positive rate)', () => {
    const snap = makeSnapshot({ fundingRatePercent: 0.6 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(1)
  })

  it('negative threshold: fires when rate <= threshold (−0.6 ≤ −0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: -0.5 }
    const snap = makeSnapshot({ fundingRatePercent: -0.6 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(1)
  })

  it('negative threshold: filtered when rate > threshold (−0.4 > −0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: -0.5 }
    const snap = makeSnapshot({ fundingRatePercent: -0.4 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(0)
  })

  it('negative threshold: fires at boundary (−0.5 ≤ −0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: -0.5 }
    const snap = makeSnapshot({ fundingRatePercent: -0.5 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(1)
  })

  it('negative threshold: filtered for positive rate (+0.6 > −0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: -0.5 }
    const snap = makeSnapshot({ fundingRatePercent: 0.6 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(0)
  })

  it('positive threshold: fires when rate >= threshold (+0.6 ≥ +0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: 0.5 }
    const snap = makeSnapshot({ fundingRatePercent: 0.6 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(1)
  })

  it('positive threshold: filtered when rate < threshold (+0.4 < +0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: 0.5 }
    const snap = makeSnapshot({ fundingRatePercent: 0.4 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(0)
  })

  it('positive threshold: fires at boundary (+0.5 ≥ +0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: 0.5 }
    const snap = makeSnapshot({ fundingRatePercent: 0.5 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(1)
  })

  it('positive threshold: filtered for negative rate (−0.6 < +0.5)', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, funding_threshold: 0.5 }
    const snap = makeSnapshot({ fundingRatePercent: -0.6 })
    expect(rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(0)
  })

  it('mainSide and funding_threshold are independent: short+negative fires with side=short', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, mainSide: 'short', funding_threshold: -0.5 }
    const snap = makeSnapshot({ fundingRatePercent: -0.6 })
    const [intent] = rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))
    expect(intent?.side).toBe('short')
  })

  it('mainSide and funding_threshold are independent: long+positive fires with side=long', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, mainSide: 'long', funding_threshold: 0.5 }
    const snap = makeSnapshot({ fundingRatePercent: 0.6 })
    const [intent] = rule.evaluate(makeCtx({ config, snapshots: new Map([['BTCUSDT', snap]]) }))
    expect(intent?.side).toBe('long')
  })

  it('emits pre_funding_then_main entryPolicy', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.entryPolicy?.kind).toBe('pre_funding_then_main')
  })

  it('LONG mainSide → preFundingSide = short', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy
    if (ep?.kind !== 'pre_funding_then_main') throw new Error('wrong entry policy kind')
    expect(ep.preFundingSide).toBe('short')
    expect(ep.mainSide).toBe('long')
  })

  it('SHORT mainSide → preFundingSide = long', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, mainSide: 'short' }
    const [intent] = rule.evaluate(makeCtx({ config }))
    const ep = intent?.entryPolicy
    if (ep?.kind !== 'pre_funding_then_main') throw new Error('wrong entry policy kind')
    expect(ep.preFundingSide).toBe('long')
    expect(ep.mainSide).toBe('short')
  })

  it('preFundingVolume is positive and less than mainVolume', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy
    if (ep?.kind !== 'pre_funding_then_main') throw new Error('wrong entry policy kind')
    expect(ep.preFundingVolume).toBeGreaterThan(0)
    expect(ep.preFundingVolume).toBeLessThan(ep.mainVolume)
  })

  it('emits sl_tp_deadline_post_funding_event exitPolicy', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.exitPolicy.kind).toBe('sl_tp_deadline_post_funding_event')
  })

  it('timeoutAt = fundingTs + fundingFeeTimeoutSeconds * 1000', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.exitPolicy
    if (ep?.kind !== 'sl_tp_deadline_post_funding_event') throw new Error('wrong exit policy kind')
    expect(ep.timeoutAt).toBe(1_700_000_000_000 + 8_000)
  })

  it('deadlineAt = fundingTs + deadlineSeconds * 1000', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.exitPolicy
    if (ep?.kind !== 'sl_tp_deadline_post_funding_event') throw new Error('wrong exit policy kind')
    expect(ep.deadlineAt).toBe(1_700_000_000_000 + 3_300_000)
  })

  it('tpMultiplier and slMultiplier propagate', () => {
    const config: Strategy6Config = { ...BASE_CONFIG, tpMultiplier: 0.3, slMultiplier: 2.0 }
    const [intent] = rule.evaluate(makeCtx({ config }))
    const ep = intent?.exitPolicy
    if (ep?.kind !== 'sl_tp_deadline_post_funding_event') throw new Error('wrong exit policy kind')
    expect(ep.tpMultiplier).toBe(0.3)
    expect(ep.slMultiplier).toBe(2.0)
  })

  it('produces deterministic intent id for same key', () => {
    const [a] = rule.evaluate(makeCtx())
    const [b] = rule.evaluate(makeCtx())
    expect(a?.id).toBeDefined()
    expect(a?.id).toBe(b?.id)
  })

  it('returns empty when config id is not strategy_6', () => {
    const ctx = makeCtx({ config: { id: 'strategy_1' } as never })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('returns empty when snapshot is missing', () => {
    expect(rule.evaluate(makeCtx({ snapshots: new Map() }))).toHaveLength(0)
  })

  it('returns empty when market is missing', () => {
    expect(rule.evaluate(makeCtx({ markets: () => undefined }))).toHaveLength(0)
  })

  it('returns empty when market is not trading', () => {
    expect(rule.evaluate(makeCtx({ markets: () => makeMarket({ status: 'halted' }) }))).toHaveLength(0)
  })

  it('returns empty when refPrice is undefined', () => {
    const ruleNoPrice = createStrategy6Rule({ ids, refPrice: () => undefined })
    expect(ruleNoPrice.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when main qty computation fails (price too high for mainAmountUsd)', () => {
    const ruleHighPrice = createStrategy6Rule({ ids, refPrice: () => 50_000 })
    expect(ruleHighPrice.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when minCost too high for pre-funding', () => {
    // minCost so high that computeMinOrderQty returns a qty >= mainQty
    const market = makeMarket({ minCost: 1_000_000 })
    expect(rule.evaluate(makeCtx({ markets: () => market }))).toHaveLength(0)
  })
})
