import { describe, it, expect } from 'vitest'
import { Strategy2 } from '../../strategies/strategy-2.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES, DEFAULT_SLIPPAGE } from './fixtures.js'
import { buildLookaheadContext } from '../../engine/localization.js'
import type { OHLCWindow, FundingEvent } from '../../data/types.js'

const TOLERANCE = 1e-10

const DROP_PARAMS = { dropSearchWindowSeconds: 10, dropQualifierFundingMult: 0.5, dropQualifierRangeMult: 3.0 }

/** Build the engine-supplied lookahead context (drop localization + gated window). */
function ctx(window: OHLCWindow, event: FundingEvent) {
  return buildLookaheadContext(window, event.funding_time, event.funding_rate, DROP_PARAMS)
}

describe('E2E: Strategy 2 — Retracement Exit', () => {
  it('Scenario 3: Retracement hit before deadline', () => {
    const strategy = new Strategy2()
    strategy.initialize(
      {
        strategy_id: 'strategy_2',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_multiplier: 1.5, // SL at ~50005 * 0.985 = ~49254 — far below test drop of 49800
        funding_applied_on_same_second: false,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    // Price drops to 49800 at T+5, then retraces
    // P_funding (bid_open at T) = 50000, P_low = 49800, P_target = 49900
    const overrides = new Map<
      number,
      Partial<{
        bidOpen: number
        bidHigh: number
        bidLow: number
        askOpen: number
        askHigh: number
        askLow: number
      }>
    >()
    overrides.set(-5, { askOpen: 50005 }) // Entry
    overrides.set(0, { bidOpen: 50000, bidHigh: 50010, bidLow: 49990 }) // P_funding
    overrides.set(5, { bidOpen: 49810, bidHigh: 49820, bidLow: 49800 }) // P_low
    overrides.set(10, { bidOpen: 49910, bidHigh: 49920, bidLow: 49890 }) // Retracement fills

    const window = buildWindow({
      fundingTime,
      basePrice,
      overrides,
      priceFn: offset => {
        if (offset < 0) return basePrice
        if (offset <= 5) return basePrice - offset * 40 // dropping
        return 49800 + (offset - 5) * 20 // recovering
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('tp_hit')
    expect(result.funding_received).toBe(true)
    // Exit at retracement target price — maker fee
    expect(result.pnl.fees).toBeCloseTo(0.0004 + 0.0002, TOLERANCE) // taker + maker
  })

  it('Scenario 4: No retracement, deadline exit', () => {
    const strategy = new Strategy2()
    strategy.initialize(
      {
        strategy_id: 'strategy_2',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_multiplier: 1.5, // SL at ~50005 * 0.985 = ~49255 — max drop is 50000 - 60*5 = 49700 > 49255
        funding_applied_on_same_second: false,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')

    // Price declines throughout: P_low keeps updating so the retracement target keeps moving
    // down and is never reached.
    const overrides = new Map<number, Partial<{ bidHigh: number; bidLow: number }>>()
    for (let offset = 0; offset <= 60; offset++) {
      const price = 50000 - offset * 5
      overrides.set(offset, { bidHigh: price, bidLow: price })
    }
    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      overrides,
      priceFn: offset => {
        if (offset < 0) return 50000
        return 50000 - offset * 5
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('deadline')
    // Deadline exit: two taker fees
    expect(result.pnl.fees).toBeCloseTo(0.0004 * 2, TOLERANCE)
  })

  it('Scenario Settlement (buffer=1): TP gated to T_drop+1s, not T_low+1s', () => {
    // Design (F=-0.01 → Q≈0.5%, prev_close = prev bid_open in fixtures):
    //   entry T-5s, askOpen=50005, sl_multiplier=1.0 → slPrice≈49505
    //   T+0: bidOpen=49800, bidLow=49760  (drop_move 0.48% < Q → not localized)
    //   T+1: bidOpen=49700, bidLow=49690  ← global P_low (T_low+1 = T+2)
    //   T+2: bidOpen=49750, bidLow=49700
    //   T+3: bidOpen=50000, bidLow=49745
    //   T+4: bidOpen=50000, bidLow=49700  (drop_move 0.6% ≥ Q → T_drop localized here)
    //
    //   pFunding=49800, P_low=49690, pTarget=49745
    //   With buffer=1: tpValidFrom=max(T+2, T+4+1)=T+5, TP fires T+5.
    //   All bid_lows > slPrice → SL never fires.
    const strategy = new Strategy2()
    strategy.initialize(
      {
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
      },
      BINANCE_FEES,
      0,
      { tp_post_settlement_buffer_seconds: 1 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: 50005 })
    overrides.set(0, { bidOpen: 49800, bidLow: 49760 })
    overrides.set(1, { bidOpen: 49700, bidLow: 49690 })
    overrides.set(2, { bidOpen: 49750, bidLow: 49700 })
    overrides.set(3, { bidOpen: 50000, bidLow: 49745 })
    overrides.set(4, { bidOpen: 50000, bidHigh: 50100, bidLow: 49700 })

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('tp_hit')
    expect(result.real_settlement_detected).toBe(true)
    expect(result.real_settlement_ts).toBe(
      new Date(fundingTime.getTime() + 4000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
    )
    // exit at T+5 (not T+2)
    const exitTimeMs = fundingTime.getTime() - 5000 + result.hold_duration * 1000
    expect(exitTimeMs).toBe(fundingTime.getTime() + 5000)
    // funding credited: exit(T+5) >= T_drop(T+4)
    expect(result.funding_received).toBe(true)
  })

  it('Scenario Settlement (buffer=0): TP gated to T_drop, not T_low+1s', () => {
    // Same design but buffer=0: tpValidFrom=max(T+2, T+4)=T+4, TP fires at T+4.
    const strategy = new Strategy2()
    strategy.initialize(
      {
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
      },
      BINANCE_FEES,
      0,
      { tp_post_settlement_buffer_seconds: 0 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: 50005 })
    overrides.set(0, { bidOpen: 49800, bidLow: 49760 })
    overrides.set(1, { bidOpen: 49700, bidLow: 49690 })
    overrides.set(2, { bidOpen: 49750, bidLow: 49700 })
    overrides.set(3, { bidOpen: 50000, bidLow: 49745 })
    overrides.set(4, { bidOpen: 50000, bidHigh: 50100, bidLow: 49700 })

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('tp_hit')
    expect(result.real_settlement_detected).toBe(true)
    // exit at T+4 (not T+2): tpValidFrom=max(T+2, T+4)=T+4, bid_high at T+4=50100>pTarget
    const exitTimeMs = fundingTime.getTime() - 5000 + result.hold_duration * 1000
    expect(exitTimeMs).toBe(fundingTime.getTime() + 4000)
    // exitTs == T_drop and fundingAppliedOnSameSecond=false → no funding
    expect(result.funding_received).toBe(false)
  })

  it('Scenario SL: Sharp drop triggers SL before T_low', () => {
    // Entry at T-5s. Price immediately drops below SL right after entry.
    // SL fires at entry+1s (pre-funding), before T_low can be identified.
    const strategy = new Strategy2()
    strategy.initialize(
      {
        strategy_id: 'strategy_2',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_multiplier: 1.5,
        funding_applied_on_same_second: false,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset <= -5) return 50000 // entry candle
        return 49200 // drops well below slPrice (~49255) right after entry
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('sl_hit')
    expect(result.pnl.net_pnl).toBeLessThan(0)
  })
})
