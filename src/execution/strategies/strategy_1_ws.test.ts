import { describe, expect, it } from 'vitest'

import { createIds } from '../core/ids.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'
import { createStrategy1WsRule } from './strategy_1_ws.js'
import type { EvalContext, Strategy1WsConfig } from './types.js'

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

const BASE_CONFIG: Strategy1WsConfig = {
  id: 'strategy_1_ws',
  enabled: true,
  negativeFundingThresholdPercent: -0.5,
  entryOffsetSeconds: 10,
  fundingFeeTimeoutSeconds: 8,
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

describe('createStrategy1WsRule', () => {
  const ids = createIds()
  const rule = createStrategy1WsRule({ ids, refPrice: () => 1000 })

  it('returns intent when threshold met', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.strategy).toBe('strategy_1_ws')
    expect(intent?.side).toBe('long')
    expect(intent?.exchange).toBe('binance')
    expect(intent?.symbol).toBe('BTCUSDT')
    expect(intent?.amountUsd).toBe(20)
    expect(intent?.leverage).toBe(4)
    expect(intent?.entryAt).toBe(1_700_000_000_000 - 10_000)
    expect(intent?.volume).toBeGreaterThan(0)
  })

  it('emits funding_fee_event exitPolicy', () => {
    const [intent] = rule.evaluate(makeCtx())
    expect(intent?.exitPolicy.kind).toBe('funding_fee_event')
  })

  it('fundingTs === nextFundingTimestamp', () => {
    const [intent] = rule.evaluate(makeCtx())
    const p = intent?.exitPolicy as { fundingTs: number }
    expect(p.fundingTs).toBe(1_700_000_000_000)
  })

  it('timeoutAt === nextFundingTimestamp + fundingFeeTimeoutSeconds * 1000', () => {
    const [intent] = rule.evaluate(makeCtx())
    const p = intent?.exitPolicy as { timeoutAt: number }
    expect(p.timeoutAt).toBe(1_700_000_000_000 + 8_000)
  })

  it('uses fundingFeeTimeoutSeconds from config', () => {
    const custom: Strategy1WsConfig = { ...BASE_CONFIG, fundingFeeTimeoutSeconds: 15 }
    const r = createStrategy1WsRule({ ids, refPrice: () => 1000 })
    const [intent] = r.evaluate(makeCtx({ config: custom }))
    const p = intent?.exitPolicy as { timeoutAt: number }
    expect(p.timeoutAt).toBe(1_700_000_000_000 + 15_000)
  })

  it('returns empty when config id is not strategy_1_ws', () => {
    const ctx = makeCtx({ config: { id: 'strategy_1' } as never })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('returns empty when funding rate above threshold (-0.3 > -0.5)', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.3 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(0)
  })

  it('passes at exactly the threshold (-0.5 <= -0.5)', () => {
    const snap = makeSnapshot({ fundingRatePercent: -0.5 })
    const ctx = makeCtx({ snapshots: new Map([['BTCUSDT', snap]]) })
    expect(rule.evaluate(ctx)).toHaveLength(1)
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
    const r = createStrategy1WsRule({ ids, refPrice: () => undefined })
    expect(r.evaluate(makeCtx())).toHaveLength(0)
  })

  it('produces deterministic intent id for same key', () => {
    const [a] = rule.evaluate(makeCtx())
    const [b] = rule.evaluate(makeCtx())
    expect(a?.id).toBeDefined()
    expect(a?.id).toBe(b?.id)
  })
})
