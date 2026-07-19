import { describe, it, expect } from 'vitest'

import { GeneratedBacktestStrategySchema, GeneratedBacktestOnlyBaseSchema } from './generate-backtest.js'
import { GeneratedLiveStrategySchema } from './generate-live.js'

describe('canonical registry — backtest/live round-trip', () => {
  it('accepts an equivalent strategy_2 config on both generated schemas', () => {
    const bt = GeneratedBacktestStrategySchema.parse({
      strategy_id: 'strategy_2',
      direction: 'long',
      negative_funding_threshold_percent: -0.4,
      entry_offset_seconds: 5,
      retracement_pct: 0.5,
      deadline_seconds: 60,
      sl_multiplier: 1.0,
      funding_applied_on_same_second: false,
      amount_usd: 20,
      leverage: 4,
    }) as Record<string, unknown>

    const live = GeneratedLiveStrategySchema.parse({
      id: 'strategy_2',
      enabled: true,
      negativeFundingThresholdPercent: -0.4,
      entryOffsetSeconds: 5,
      retracementPct: 0.5,
      deadlineSeconds: 60,
      slMultiplier: 1.0,
      fundingFeeTimeoutSeconds: 30,
      amountUsd: 20,
      leverage: 4,
    }) as Record<string, unknown>

    expect(bt.negative_funding_threshold_percent).toBe(live.negativeFundingThresholdPercent)
    expect(bt.entry_offset_seconds).toBe(live.entryOffsetSeconds)
    expect(bt.retracement_pct).toBe(live.retracementPct)
    expect(bt.deadline_seconds).toBe(live.deadlineSeconds)
    expect(bt.sl_multiplier).toBe(live.slMultiplier)
    expect(bt.amount_usd).toBe(live.amountUsd)
    expect(bt.leverage).toBe(live.leverage)
  })

  it('defaults negativeFundingThresholdPercent / negative_funding_threshold_percent to -0.4 for strategy_1', () => {
    const bt = GeneratedBacktestStrategySchema.parse({
      strategy_id: 'strategy_1',
      direction: 'long',
      entry_offset_seconds: 5,
      exit_offset_seconds: 6,
      funding_applied_on_same_second: false,
    }) as Record<string, unknown>
    const live = GeneratedLiveStrategySchema.parse({ id: 'strategy_1' }) as Record<string, unknown>

    expect(bt.negative_funding_threshold_percent).toBe(-0.4)
    expect(live.negativeFundingThresholdPercent).toBe(-0.4)
  })

  it('defaults negativeFundingThresholdPercent to -0.4 for strategy_1_ws (was -0.5, OQ-7)', () => {
    const live = GeneratedLiveStrategySchema.parse({ id: 'strategy_1_ws' }) as Record<string, unknown>
    expect(live.negativeFundingThresholdPercent).toBe(-0.4)
  })

  it('defaults negativeFundingThresholdPercent to -0.4 for strategy_3a (was -0.5, OQ-7)', () => {
    const live = GeneratedLiveStrategySchema.parse({ id: 'strategy_3a' }) as Record<string, unknown>
    expect(live.negativeFundingThresholdPercent).toBe(-0.4)
  })

  it('accepts amount_usd/leverage on every backtest strategy', () => {
    const strategies = [
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        exit_offset_seconds: 6,
        funding_applied_on_same_second: false,
        amount_usd: 20,
        leverage: 4,
      },
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        limit_offset_mult: 0.75,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
        amount_usd: 20,
        leverage: 4,
      },
    ]
    for (const s of strategies) {
      const parsed = GeneratedBacktestStrategySchema.parse(s) as Record<string, unknown>
      expect(parsed.amount_usd).toBe(20)
      expect(parsed.leverage).toBe(4)
    }
  })

  it('parses the 7 backtest-only BaseConfig keys with their canonical defaults', () => {
    const parsed = GeneratedBacktestOnlyBaseSchema.parse({}) as Record<string, unknown>
    expect(parsed.market_slippage_pct).toBe(0.05)
    expect(parsed.order_latency_ms).toBe(1000)
    expect(parsed.ws_event_miss_rate).toBe(0.02)
    expect(parsed.ws_exit_extra_delay_seconds).toBe(2)
    expect(parsed.drop_search_window_seconds).toBe(10)
    expect(parsed.drop_qualifier_funding_mult).toBe(0.5)
    expect(parsed.drop_qualifier_range_mult).toBe(3.0)
  })
})
