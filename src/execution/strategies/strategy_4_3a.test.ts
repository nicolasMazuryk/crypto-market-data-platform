import { describe, expect, it } from 'vitest'

import { createIds } from '../core/ids.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'
import { createStrategy4_3aRule } from './strategy_4_3a.js'
import type { EvalContext, Strategy4_3aConfig } from './types.js'

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

const BASE_CONFIG: Strategy4_3aConfig = {
  id: 'strategy_4_3a',
  enabled: true,
  negativeFundingThresholdPercent: -0.4,
  entryOffsetSeconds: 2,
  entryMult: 0.75,
  slMultiplier: 1.5,
  takeProfitPct: 0.3,
  deadlineSeconds: 60,
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

describe('createStrategy4_3aRule', () => {
  const ids = createIds()
  const rule = createStrategy4_3aRule({ ids, refPrice: () => 1000 })

  it('returns intent when threshold met', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.strategy).toBe('strategy_4_3a')
    expect(intent?.side).toBe('long')
    expect(intent?.entryAt).toBe(1_700_000_000_000 - 2_000) // 2s offset
    expect(intent?.volume).toBeGreaterThan(0)
  })

  it('emits limit entryPolicy with entryMult-derived priceOffsetPct', () => {
    // F=-0.6%, entryMult=0.75 → priceOffsetPct = 0.6 * 0.75 = 0.45
    const [intent] = rule.evaluate(makeCtx())
    const ep = intent?.entryPolicy as { kind: 'limit'; priceOffsetPct: number; expireAt: number }
    expect(ep.kind).toBe('limit')
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
    expect(p.tpPct).toBe(0.3)
  })

  it('2s entryOffset gives tighter window than 4_2a default 5s', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.entryAt).toBe(1_700_000_000_000 - 2_000)
  })

  it('returns empty when funding rate above threshold', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.3 })
    expect(rule.evaluate(makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(0)
  })

  it('passes at exactly the threshold', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.4 })
    expect(rule.evaluate(makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) }))).toHaveLength(1)
  })

  it('returns empty when config id is not strategy_4_3a', () => {
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
    const r = createStrategy4_3aRule({ ids, refPrice: () => undefined })
    expect(r.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when qty is zero (price too high)', () => {
    const r = createStrategy4_3aRule({ ids, refPrice: () => 50_000 })
    expect(r.evaluate(makeCtx())).toHaveLength(0)
  })

  it('produces deterministic intent id for same key', () => {
    const [a] = rule.evaluate(makeCtx())
    const [b] = rule.evaluate(makeCtx())
    expect(a?.id).toBeDefined()
    expect(a?.id).toBe(b?.id)
  })

  it('produces different id from strategy_4_2a for same event', () => {
    // Same symbol/exchange/time but different strategy prefix should yield different id
    const [a] = rule.evaluate(makeCtx())
    const otherId = ids.intentId('strategy_4_2a', 'binance', 'BTCUSDT', 1_700_000_000_000)
    expect(a?.id).not.toBe(otherId)
  })
})
