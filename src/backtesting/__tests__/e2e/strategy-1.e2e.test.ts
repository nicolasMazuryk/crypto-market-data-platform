import { describe, it, expect } from 'vitest'
import { Strategy1 } from '../../strategies/strategy-1.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES } from './fixtures.js'
import { buildLookaheadContext } from '../../engine/localization.js'
import type { OHLCWindow, FundingEvent } from '../../data/types.js'

const TOLERANCE = 1e-10

const DROP_PARAMS = { dropSearchWindowSeconds: 10, dropQualifierFundingMult: 0.5, dropQualifierRangeMult: 3.0 }

/** Build the engine-supplied lookahead context (drop localization + gated window). */
function ctx(window: OHLCWindow, event: FundingEvent) {
  return buildLookaheadContext(window, event.funding_time, event.funding_rate, DROP_PARAMS)
}

describe('E2E: Strategy 1 — Instant Exit', () => {
  const strategy = new Strategy1()
  strategy.initialize(
    {
      strategy_id: 'strategy_1',
      direction: 'long',
      negative_funding_threshold_percent: -0.4,
      entry_offset_seconds: 5,
      exit_offset_seconds: 2,
      amount_usd: 20,
      leverage: 4,
    },
    BINANCE_FEES,
    0,
    0
  )

  it('Scenario 1: Profitable — funding > drop + fees', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const entryPrice = 50000
    const exitBidOpen = 49925 // 0.15% drop

    // Entry at T-5: ask_open = 50005 (with spread)
    // T+0: a qualifying drop localizes T_drop → exit at T_drop + 2 = T+2
    // Exit at T+2: bid_open = 49925
    const overrides = new Map<number, Partial<{ bidOpen: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: entryPrice + 5 }) // entry ask
    overrides.set(0, { bidLow: 49600 }) // drop_move 0.8% → localizes T_drop = T+0
    overrides.set(2, { bidOpen: exitBidOpen }) // exit bid

    const window = buildWindow({ fundingTime, basePrice: entryPrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    expect(strategy.shouldTrigger(event)).toBe(true)

    const result = strategy.execute(event, window, ctx(window, event))
    if (!result) throw new Error('expected result')

    const actualEntry = entryPrice + 5 // ask_open from override
    const expectedDelta = (exitBidOpen - actualEntry) / actualEntry
    const expectedFunding = 0.015
    const expectedFees = 0.0004 * 2
    const expectedNet = expectedDelta + expectedFunding - expectedFees

    expect(Math.abs(result.pnl.delta_pnl - expectedDelta)).toBeLessThan(TOLERANCE)
    expect(Math.abs(result.pnl.funding_pnl - expectedFunding)).toBeLessThan(TOLERANCE)
    expect(Math.abs(result.pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)
    expect(Math.abs(result.pnl.net_pnl - expectedNet)).toBeLessThan(TOLERANCE)
    expect(result.pnl.net_pnl).toBeGreaterThan(0) // Profitable!
    expect(result.exit_reason).toBe('timed')
    expect(result.funding_received).toBe(true)
  })

  it('Scenario 2: Losing — funding < drop + fees', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const entryPrice = 50000
    const exitBidOpen = 49600 // 0.8% drop

    const overrides = new Map<number, Partial<{ bidOpen: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: entryPrice + 5 })
    overrides.set(0, { bidLow: 49600 }) // localizes T_drop = T+0
    overrides.set(2, { bidOpen: exitBidOpen })

    const window = buildWindow({ fundingTime, basePrice: entryPrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.005 }) // Only 0.5%

    const result = strategy.execute(event, window, ctx(window, event))
    if (!result) throw new Error('expected result')
    expect(result.pnl.net_pnl).toBeLessThan(0) // Losing!
  })

  it('Scenario 17: Funding rate below threshold — not triggered', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.003 }) // Below 0.4%
    expect(strategy.shouldTrigger(event)).toBe(false)
  })

  it('Scenario 17b: Positive funding rate — not triggered', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const event = makeFundingEvent({ fundingTime, fundingRate: 0.01 })
    expect(strategy.shouldTrigger(event)).toBe(false)
  })
})

describe('E2E: Strategy 1 — Order Latency', () => {
  it('entry decision at candle t fills at candle t+1 (1000ms latency), not t', () => {
    const latencyStrategy = new Strategy1()
    latencyStrategy.initialize(
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        exit_offset_seconds: 2,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0,
      1000 // orderLatencyMs: fill 1 candle after the decision
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const decisionAskOpen = 51000 // at decision candle T-5 — must NOT be used for the fill
    const fillAskOpen = 50005 // at fill candle T-4 (decision + 1000ms) — must be used

    const overrides = new Map<number, Partial<{ bidOpen: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: decisionAskOpen })
    overrides.set(-4, { askOpen: fillAskOpen })
    overrides.set(0, { bidLow: 49600 }) // localizes T_drop = T+0
    overrides.set(2, { bidOpen: 49900 }) // exit decision candle — must NOT be used for the fill
    overrides.set(3, { bidOpen: 49800 }) // exit fill candle (T_drop+2+1000ms) — must be used

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = latencyStrategy.execute(event, window, ctx(window, event))
    if (!result) throw new Error('expected result')

    expect(result.entry_price).toBe(fillAskOpen)
    expect(result.entry_price).not.toBe(decisionAskOpen)
    expect(result.exit_price).toBe(49800)
    expect(result.exit_price).not.toBe(49900)
  })
})

describe('E2E: Strategy 1 — Settlement Localization', () => {
  it('Scenario Settlement A: exit ignores T_drop — fires at T_settle+exit_offset even when the drop localizes later (T+8)', () => {
    // Drop localizes at T_settle+8. exit_offset=6 → fixed-clock exit at T+6, i.e. BEFORE the
    // drop (favorable variance). The old T_drop-keyed exit would have fired at T+8+6=T+14.
    const strat = new Strategy1()
    strat.initialize(
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        exit_offset_seconds: 6,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0,
      0,
      { tp_post_settlement_buffer_seconds: 1 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const exitBidOpen = 49950 // price at fixed-clock exit T+6

    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 }) // entry candle
    // T+8: qualifying drop (drop_move 0.8% ≥ Q≈0.75%) → localizes T_drop here, after the exit
    overrides.set(8, { bidOpen: basePrice, bidHigh: basePrice + 10, bidLow: basePrice - 400 })
    overrides.set(6, { bidOpen: exitBidOpen }) // exit candle at fixed clock T_settle+6

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = strat.execute(event, window, ctx(window, event))
    if (!result) throw new Error('expected result')

    expect(result.real_settlement_detected).toBe(true)
    expect(result.t_drop_offset_s).toBe(8)
    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 6000)
  })

  it('Scenario Settlement B: exit ignores T_drop — fires at the same T_settle+exit_offset when the drop localizes earlier (T+2)', () => {
    // Same fixed clock (T+6) as Scenario A, but the drop localizes earlier this time (T+2), i.e.
    // the exit now fires AFTER the drop. The absolute exit clock must not move.
    const strat = new Strategy1()
    strat.initialize(
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        exit_offset_seconds: 6,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0,
      0,
      { tp_post_settlement_buffer_seconds: 1 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const exitBidOpen = 49950 // price at fixed-clock exit T+6

    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 }) // entry candle
    // T+2: qualifying drop → localizes T_drop here, before the exit
    overrides.set(2, { bidOpen: basePrice, bidHigh: basePrice + 10, bidLow: basePrice - 400 })
    overrides.set(6, { bidOpen: exitBidOpen }) // exit candle at fixed clock T_settle+6 (unchanged)

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = strat.execute(event, window, ctx(window, event))
    if (!result) throw new Error('expected result')

    expect(result.real_settlement_detected).toBe(true)
    expect(result.t_drop_offset_s).toBe(2)
    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 6000)
    // Funding received: entry(T-5) <= T_settle(T) <= exit(T+6)
    expect(result.funding_received).toBe(true)
  })

  it('Scenario Settlement-Boundary: accrual is tested against T_settle, not the localized T_drop', () => {
    // Regression for C1: entry lands exactly at T_settle (entry_offset_seconds=0), while the
    // qualifying drop localizes a few seconds *after* T_settle (T_drop = T+3 > T_settle = T).
    // Per §5.5 an entry filled AT-OR-AFTER T_settle earns nothing, so funding_received must be
    // false. The old code tested entryTs against tDropTs (T+3) instead of T_settle (T): since
    // entryTs (T) < tDropTs (T+3), it wrongly credited funding.
    const strat = new Strategy1()
    strat.initialize(
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 0,
        exit_offset_seconds: 2,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0,
      0,
      { tp_post_settlement_buffer_seconds: 1 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(0, { askOpen: basePrice + 5 }) // entry candle at T_settle
    // T+3: qualifying drop → localizes T_drop here, after T_settle
    overrides.set(3, { bidOpen: basePrice, bidHigh: basePrice + 10, bidLow: basePrice - 400 })
    // Exit candle at fixed clock T_settle(T) + exit_offset(2) = T+2 — left at its default flat
    // price so it doesn't perturb the T+3 drop candle's prev_close (T+2's bid_close).

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = strat.execute(event, window, ctx(window, event))
    if (!result) throw new Error('expected result')

    expect(result.real_settlement_detected).toBe(true)
    expect(result.real_settlement_ts).toBe(
      new Date(fundingTime.getTime() + 3000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
    )
    // entryTs (T_settle) >= fundingTs (T_settle) → pessimistic rule: no funding, regardless of T_drop
    expect(result.funding_received).toBe(false)
  })

  it('Scenario Settlement-Fallback: no drop localized → exit still fixed at T_settle + exit_offset', () => {
    // All candles flat (no qualifying drop) → t_drop_offset_s is null, but the exit clock is
    // fixed regardless of drop localization, so it fires at T_settle + exit_offset = T+2.
    const strat = new Strategy1()
    strat.initialize(
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        exit_offset_seconds: 2,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0,
      0,
      { tp_post_settlement_buffer_seconds: 1 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    // Override all candles in [T, T+10] to be flat (bid_open == bid_low) → no qualifying drop
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 })
    for (let i = 0; i <= 10; i++) {
      overrides.set(i, { bidOpen: basePrice, bidHigh: basePrice + 5, bidLow: basePrice }) // flat
    }

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = strat.execute(event, window, ctx(window, event))
    if (!result) throw new Error('expected result')

    expect(result.real_settlement_detected).toBe(false)
    expect(result.t_drop_offset_s).toBeNull()
    // Exit clock ignores drop localization entirely: T_settle + exit_offset(2) = T+2
    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 2000)
  })
})
