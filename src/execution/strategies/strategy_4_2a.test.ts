import { describe, expect, it } from 'vitest'

import { createIds } from '../core/ids.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'
import { createStrategy4_2aRule } from './strategy_4_2a.js'
import type { EvalContext, Strategy4_2aConfig } from './types.js'

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

const BASE_CONFIG: Strategy4_2aConfig = {
  id: 'strategy_4_2a',
  enabled: true,
  negativeFundingThresholdPercent: -0.4,
  entryOffsetSeconds: 5,
  limitOffsetMult: 0.75,
  takeProfitPct: 0.2,
  deadlineSeconds: 60,
  slMultiplier: 1.5,
  amountUsd: 20,
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

describe('createStrategy4_2aRule', () => {
  const ids = createIds()
  const rule = createStrategy4_2aRule({ ids, refPrice: () => 1000 })

  it('returns intent when threshold met', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.strategy).toBe('strategy_4_2a')
    expect(intent?.side).toBe('long')
    expect(intent?.exchange).toBe('binance')
    expect(intent?.symbol).toBe('BTCUSDT')
    expect(intent?.amountUsd).toBe(20)
    expect(intent?.leverage).toBe(4)
    expect(intent?.entryAt).toBe(1_700_000_000_000 - 5_000)
    expect(intent?.volume).toBeGreaterThan(0)
  })

  it('emits limit entryPolicy with correct priceOffsetPct', () => {
    // F=-0.6%, limitOffsetMult=0.75 → priceOffsetPct = 0.6 * 0.75 = 0.45
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.entryPolicy?.kind).toBe('limit')
    const ep = intent?.entryPolicy as { kind: 'limit'; priceOffsetPct: number; expireAt: number }
    expect(ep.priceOffsetPct).toBeCloseTo(0.45, 10)
    expect(ep.expireAt).toBe(1_700_000_000_000 + 60_000)
  })

  it('emits sl_tp_deadline exitPolicy', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.exitPolicy.kind).toBe('sl_tp_deadline')
  })

  it('slPct = |F%| × slMultiplier (F=-0.6%, mult=1.5 → slPct=0.9)', () => {
    const [intent] = rule.evaluate(makeCtx())
    const p = intent?.exitPolicy as { slPct: number }
    expect(p.slPct).toBeCloseTo(0.9, 10)
  })

  it('tpPct === config.takeProfitPct', () => {
    const [intent] = rule.evaluate(makeCtx())
    const p = intent?.exitPolicy as { tpPct: number }
    expect(p.tpPct).toBe(0.2)
  })

  it('deadlineAt === nextFundingTimestamp + deadlineSeconds * 1000', () => {
    const [intent] = rule.evaluate(makeCtx())
    const p = intent?.exitPolicy as { deadlineAt: number }
    expect(p.deadlineAt).toBe(1_700_000_000_000 + 60_000)
  })

  it('expireAt equals deadlineAt', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy as { expireAt: number }
    const exitP = intent?.exitPolicy as { deadlineAt: number }
    expect(ep.expireAt).toBe(exitP.deadlineAt)
  })

  it('returns empty when funding rate above threshold', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.3 })
    expect(rule.evaluate(makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(0)
  })

  it('passes at exactly the threshold (-0.4 <= -0.4)', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.4 })
    expect(rule.evaluate(makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(1)
  })

  it('returns empty when config id is not strategy_4_2a', () => {
    expect(rule.evaluate(makeCtx({ config: { id: 'strategy_1' } as never }))).toHaveLength(0)
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
    const r = createStrategy4_2aRule({ ids, refPrice: () => undefined })
    expect(r.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when qty is zero (price too high)', () => {
    const r = createStrategy4_2aRule({ ids, refPrice: () => 50_000 })
    expect(r.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when minCost too high', () => {
    expect(rule.evaluate(makeCtx({ markets: () => makeMarket({ minCost: 100_000 }) }))).toHaveLength(0)
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

  it('priceOffsetPct scales with funding rate', () => {
    const snap = makeSnapshot({ fundingRatePercent: -1.0 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    const [intent] = rule.evaluate(ctx)
    // F=1.0%, limitOffsetMult=0.75 → priceOffsetPct=0.75
    const ep = intent?.entryPolicy as { priceOffsetPct: number }
    expect(ep.priceOffsetPct).toBeCloseTo(0.75, 10)
  })
})
