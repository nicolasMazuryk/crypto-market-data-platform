import { describe, expect, it } from 'vitest'

import { createIds } from '../core/ids.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'
import { createStrategy3Rule } from './strategy_3.js'
import type { EvalContext, Strategy3aConfig } from './types.js'

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

const BASE_CONFIG_3A: Strategy3aConfig = {
  id: 'strategy_3a',
  tpVariant: 'A',
  enabled: true,
  negativeFundingThresholdPercent: -0.4,
  entryOffsetSeconds: 5,
  stopLossPercent: 1.0,
  tpVariantAMultiplier: 1.5,
  tpVariantBOffsetPercent: 0.4,
  deadlineSeconds: 300,
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
    config: BASE_CONFIG_3A,
    ...overrides,
  }
}

describe('createStrategy3Rule', () => {
  const ids = createIds()
  const rule = createStrategy3Rule({ ids, refPrice: () => 1000 })

  it('returns intent when threshold met', () => {
    const intents = rule.evaluate(makeCtx())
    expect(intents).toHaveLength(1)
    const [intent] = intents
    expect(intent?.strategy).toBe('strategy_3a')
    expect(intent?.side).toBe('short')
    expect(intent?.exchange).toBe('binance')
    expect(intent?.symbol).toBe('BTCUSDT')
    expect(intent?.amountUsd).toBe(10)
    expect(intent?.leverage).toBe(5)
    const entryAt = 1_700_000_000_000 - 5_000
    expect(intent?.entryAt).toBe(entryAt)
    expect(intent?.exitPolicy.kind).toBe('sl_tp_deadline')
  })

  it('variant A: tpPct = |F| * 1.5 (F=-0.6% → tpPct=0.9)', () => {
    const [intent] = rule.evaluate(makeCtx())
    const policy = intent?.exitPolicy as { kind: string; slPct: number; tpPct: number; tpVariant: string }
    expect(policy.kind).toBe('sl_tp_deadline')
    expect(policy.slPct).toBe(1.0)
    expect(policy.tpPct).toBeCloseTo(0.9, 5)
    expect(policy.tpVariant).toBe('A')
  })

  it('deadlineAt === nextFundingTimestamp + deadlineSeconds * 1000', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect((intent?.exitPolicy as { deadlineAt: number }).deadlineAt).toBe(1_700_000_000_000 + 300_000)
  })

  it('slPct matches config.stopLossPercent', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect((intent?.exitPolicy as { slPct: number }).slPct).toBe(1.0)
  })

  it('returns empty when funding rate above threshold (-0.3 > -0.4)', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.3 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('passes at exactly the threshold (-0.4 <= -0.4)', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.4 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(1)
  })

  it('returns empty when config id is not strategy_3a', () => {
    const ctx = makeCtx({ config: { ...BASE_CONFIG_3A, id: 'strategy_4_1a' } as unknown as EvalContext['config'] })
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
    const ruleNoPrice = createStrategy3Rule({ ids, refPrice: () => undefined })
    expect(ruleNoPrice.evaluate(makeCtx())).toHaveLength(0)
  })

  it('returns empty when qty computation fails (price too high for amountUsd)', () => {
    const ruleHighPrice = createStrategy3Rule({ ids, refPrice: () => 50000 })
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
