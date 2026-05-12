import { describe, it, expect } from 'vitest'
import { Strategy2 } from '../../strategies/strategy-2.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES, DEFAULT_SLIPPAGE } from './fixtures.js'

const TOLERANCE = 1e-10

describe('E2E: Strategy 2 — Retracement Exit', () => {
  it('Scenario 3: Retracement hit before deadline', () => {
    const strategy = new Strategy2()
    strategy.initialize(
      {
        strategy_id: 'strategy_2',
        direction: 'long',
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_mult: 1.5, // SL at ~50005 * 0.985 = ~49254 — far below test drop of 49800
        funding_applied_on_same_second: false,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    // Price drops to 49800 at T+5, then retraces
    // P_funding (bid_open at T) = 50000
    // P_low = 49800 at T+5
    // P_target = 49800 + (50000 - 49800) * 0.50 = 49900
    // Retracement should hit at T+10 where bid_high > 49900

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
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('TP_HIT')
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
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_mult: 1.5, // SL at ~50005 * 0.985 = ~49255 — max drop is 50000 - 60*5 = 49700 > 49255
        funding_applied_on_same_second: false,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')

    // Price drops steadily and keeps dropping — P_low keeps updating so
    // the retracement target keeps moving down, never reached.
    // P_funding (bid_open at T) = 50000
    // Price keeps declining throughout the window: each second lower than the last.
    // Retracement target = P_low + (50000 - P_low) * 0.5
    // But P_low moves down each second, so target also drops and is never hit.
    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < 0) return 50000
        // Continuous decline: 50000 - offset * 5 per second
        return 50000 - offset * 5
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('DEADLINE')
    // Deadline exit: two taker fees
    expect(result.pnl.fees).toBeCloseTo(0.0004 * 2, TOLERANCE)
  })

  it('Scenario Settlement (buffer=1): TP gated to settlement+1s, not T_low+1s', () => {
    // Design:
    //   entry T-5s, askOpen=50005, f=-0.01, sl_mult=1.0 → slPrice=50005*0.99≈49505
    //   T+0: bidOpen=50000, bidLow=49990 (drop=10)
    //   T+1: bidOpen=49990, bidLow=49970 (drop=20) ← T_low, T_low+1=T+2
    //   T+4: bidOpen=50000, bidLow=49972 (drop=28, biggest → settlement detected)
    //         bidLow=49972 > T+1 bidLow=49970 → T_low stays at T+1
    //
    //   pFunding=50000, P_low=49970, pTarget=49985
    //   Without fix: tpValidFrom=T+2, TP fires T+2 (default bid_high≈50005 > 49985)
    //   With buffer=1: tpValidFrom=max(T+2, T+4+1)=T+5, TP fires T+5
    //   All bid_lows > slPrice=49505, so SL never fires.
    const strategy = new Strategy2()
    strategy.initialize(
      {
        strategy_id: 'strategy_2',
        direction: 'long',
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_mult: 1.0,
        funding_applied_on_same_second: false,
      },
      BINANCE_FEES,
      0,
      { detection_window_seconds: 10, tp_post_settlement_buffer_seconds: 1 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: 50005 })
    overrides.set(0, { bidOpen: 50000, bidHigh: 50010, bidLow: 49990 })
    overrides.set(1, { bidOpen: 49990, bidHigh: 49990, bidLow: 49970 })
    overrides.set(4, { bidOpen: 50000, bidHigh: 50100, bidLow: 49972 })

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('TP_HIT')
    expect(result.real_settlement_detected).toBe(true)
    expect(result.real_settlement_ts).toBe(
      new Date(fundingTime.getTime() + 4000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
    )
    // exit at T+5 (not T+2)
    const exitTimeMs = fundingTime.getTime() - 5000 + result.hold_duration * 1000
    expect(exitTimeMs).toBe(fundingTime.getTime() + 5000)
    // funding credited: exit(T+5) >= settlement(T+4)
    expect(result.funding_received).toBe(true)
  })

  it('Scenario Settlement (buffer=0): TP gated to settlement, not T_low+1s', () => {
    // Same design but buffer=0: tpValidFrom=max(T+2, T+4+0)=T+4, TP fires at T+4.
    const strategy = new Strategy2()
    strategy.initialize(
      {
        strategy_id: 'strategy_2',
        direction: 'long',
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_mult: 1.0,
        funding_applied_on_same_second: false,
      },
      BINANCE_FEES,
      0,
      { detection_window_seconds: 10, tp_post_settlement_buffer_seconds: 0 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: 50005 })
    overrides.set(0, { bidOpen: 50000, bidHigh: 50010, bidLow: 49990 })
    overrides.set(1, { bidOpen: 49990, bidHigh: 49990, bidLow: 49970 })
    overrides.set(4, { bidOpen: 50000, bidHigh: 50100, bidLow: 49972 })

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('TP_HIT')
    expect(result.real_settlement_detected).toBe(true)
    // exit at T+4 (not T+2): tpValidFrom=max(T+2, T+4)=T+4, bid_high at T+4=50100>49985
    const exitTimeMs = fundingTime.getTime() - 5000 + result.hold_duration * 1000
    expect(exitTimeMs).toBe(fundingTime.getTime() + 4000)
    // exitTs == settlementTs and fundingAppliedOnSameSecond=false → no funding
    expect(result.funding_received).toBe(false)
  })

  it('Scenario SL: Sharp drop triggers SL before T_low', () => {
    // Entry at T-5s. Price immediately drops below SL right after entry.
    // SL fires at entry+1s (pre-funding), before T_low can be identified.
    // F = -0.01, entry fill ≈ 50005, slPrice = 50005 * (1 - 0.01 * 1.5) ≈ 49254.9
    const strategy = new Strategy2()
    strategy.initialize(
      {
        strategy_id: 'strategy_2',
        direction: 'long',
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_mult: 1.5,
        funding_applied_on_same_second: false,
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
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('SL_HIT')
    expect(result.pnl.net_pnl).toBeLessThan(0)
  })
})
