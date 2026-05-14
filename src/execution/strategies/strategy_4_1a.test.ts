import { describe, expect, it } from 'vitest'

import { createIds } from '../core/ids.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'
import { createStrategy4_1aRule } from './strategy_4_1a.js'
import type { EvalContext, Strategy4_1aConfig } from './types.js'

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

const BASE_CONFIG: Strategy4_1aConfig = {
  id: 'strategy_4_1a',
  enabled: true,
  negativeFundingThresholdPercent: -0.4,
  entryOffsetSeconds: 5,
  ladderCount: 5,
  ladderTopMult: 0.5,
  ladderBottomMult: 1.5,
  takeProfitPct: 0.2,
  deadlineSeconds: 60,
  slMultiplier: 1.0,
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

describe('createStrategy4_1aRule', () => {
  const ids = createIds()
  const rule = createStrategy4_1aRule({ ids, refPrice: () => 1000 })

  it('returns intent when threshold met', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.strategy).toBe('strategy_4_1a')
    expect(intent?.side).toBe('long')
    expect(intent?.entryAt).toBe(1_700_000_000_000 - 5_000)
    expect(intent?.volume).toBeGreaterThan(0)
  })

  it('emits ladder_limit entryPolicy', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.entryPolicy?.kind).toBe('ladder_limit')
  })

  it('ladder has ladderCount rungs', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy as { kind: 'ladder_limit'; rungs: unknown[] }
    expect(ep.rungs).toHaveLength(5)
  })

  it('rung qtyFractions sum to approximately 1', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy as { rungs: { qtyFraction: number }[] }
    const total = ep.rungs.reduce((acc, r) => acc + r.qtyFraction, 0)
    expect(total).toBeCloseTo(1, 3)
  })

  it('rung priceOffsetPcts span from topOffset to bottomOffset', () => {
    // F=-0.6%, topMult=0.5, bottomMult=1.5 → topOffset=0.3, bottomOffset=0.9
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy as { rungs: { priceOffsetPct: number }[] }
    const offsets = ep.rungs.map(r => r.priceOffsetPct)
    expect(offsets[0]).toBeCloseTo(0.3, 5) // top (smallest offset = highest price)
    expect(offsets[offsets.length - 1]).toBeCloseTo(0.9, 5) // bottom
    // Monotonically increasing
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]!)
    }
  })

  it('expireAt === deadlineAt', () => {
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy as { expireAt: number }
    const exitP = intent?.exitPolicy as { deadlineAt: number }
    expect(ep.expireAt).toBe(exitP.deadlineAt)
    expect(ep.expireAt).toBe(1_700_000_000_000 + 60_000)
  })

  it('emits sl_tp_deadline exitPolicy', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.exitPolicy.kind).toBe('sl_tp_deadline')
  })

  it('slPct = |F%| × slMultiplier (F=-0.6%, mult=1 → slPct=0.6)', () => {
    const [intent] = rule.evaluate(makeCtx())
    const p = intent?.exitPolicy as { slPct: number }
    expect(p.slPct).toBeCloseTo(0.6, 10)
  })

  it('tpPct === config.takeProfitPct', () => {
    const [intent] = rule.evaluate(makeCtx())
    const p = intent?.exitPolicy as { tpPct: number }
    expect(p.tpPct).toBe(0.2)
  })

  it('single-rung ladder when ladderCount=1 uses topOffset', () => {
    const config: Strategy4_1aConfig = { ...BASE_CONFIG, ladderCount: 1 }
    const ctx = makeCtx({ config })
    const [intent] = createStrategy4_1aRule({ ids, refPrice: () => 1000 }).evaluate(ctx)
    const ep = intent?.entryPolicy as { rungs: { priceOffsetPct: number }[] }
    expect(ep.rungs).toHaveLength(1)
    expect(ep.rungs[0]?.priceOffsetPct).toBeCloseTo(0.3, 5) // topOffset only
  })

  it('returns empty when funding rate above threshold', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.3 })
    expect(rule.evaluate(makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(0)
  })

  it('passes at exactly the threshold', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.4 })
    expect(rule.evaluate(makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(1)
  })

  it('returns empty when config id is not strategy_4_1a', () => {
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
    const r = createStrategy4_1aRule({ ids, refPrice: () => undefined })
    expect(r.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when qty is zero (price too high)', () => {
    const r = createStrategy4_1aRule({ ids, refPrice: () => 50_000 })
    expect(r.evaluate(makeCtx())).toHaveLength(0)
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
