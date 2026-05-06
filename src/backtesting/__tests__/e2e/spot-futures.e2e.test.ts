import { describe, it, expect } from 'vitest'
import { SpotFuturesStrategy } from '../../strategies/strategy-spot-futures.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES } from './fixtures.js'
import type { FundingEvent } from '../../data/types.js'

const TOLERANCE = 1e-10

// Realistic Binance spot taker fee (0.10% per leg)
const SPOT_FEE = 0.001
// round_trip_fees = 2 * SPOT_FEE + 2 * BINANCE_FEES.taker_fee = 2*0.001 + 2*0.0004 = 0.0028
// profit gate: funding_rate - 0.0028 >= minTotalProfit (0.0005) → funding_rate >= 0.0033
// All "should execute" tests use TRIGGER_RATE = 0.005 (0.5%) to clear the gate comfortably.
const TRIGGER_RATE = 0.005

function makeConfig(overrides?: Partial<Parameters<SpotFuturesStrategy['initialize']>[0]>) {
  return {
    strategy_id: 'strategy_spot_futures' as const,
    spot_exchange: 'binance',
    perp_exchange: 'binance',
    F_threshold: 0.0015,
    entry_offset_seconds: 5,
    exit_offset_seconds: 5,
    minTotalProfit: 0.0005,
    fundingConvergenceThreshold: 0.0002,
    spreadWideningThreshold: 0.05,
    spreadTakeProfit: 0.004,
    max_carry_funding_events: 4,
    ...overrides,
  }
}

function buildWideWindow(fundingTime: Date, basePrice: number, postSeconds = 9 * 3600) {
  return buildWindow({ fundingTime, basePrice, preFunding: 60, postFunding: postSeconds })
}

function makeFundingEvents(triggerTime: Date, triggerRate: number, nextRates: number[]): FundingEvent[] {
  const events: FundingEvent[] = [makeFundingEvent({ fundingTime: triggerTime, fundingRate: triggerRate })]
  for (let i = 0; i < nextRates.length; i++) {
    const t = new Date(triggerTime.getTime() + (i + 1) * 8 * 3600 * 1000)
    events.push(makeFundingEvent({ fundingTime: t, fundingRate: nextRates[i] }))
  }
  return events
}

describe('E2E: SpotFuturesStrategy', () => {
  it('exits FUNDING_FLOOR after one cycle when next funding rate drops below threshold', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const nextFundingTime = new Date(triggerTime.getTime() + 8 * 3600 * 1000)

    const allFundingEvents = [
      makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE }),
      makeFundingEvent({ fundingTime: nextFundingTime, fundingRate: 0.00015 }), // below convergence threshold
    ]

    const perpWindow = buildWideWindow(triggerTime, basePrice)
    const spotWindow = buildWideWindow(triggerTime, basePrice) // alias mode
    const perpEvent = makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })

    expect(strategy.shouldTrigger(perpEvent)).toBe(true)

    const result = strategy.executeSpotFutures(
      perpEvent,
      perpWindow,
      spotWindow,
      allFundingEvents,
      BINANCE_FEES,
      SPOT_FEE
    )

    expect(result).not.toBeNull()
    if (!result) throw new Error('expected result')

    expect(result.exit_reason).toBe('FUNDING_FLOOR')
    expect(result.funding_events_collected).toBeGreaterThanOrEqual(1)
    expect(Math.abs(result.pnl.spread_pnl)).toBeLessThan(0.001) // alias mode: spread ≈ 0
    expect(result.pnl.funding_pnl).toBeGreaterThan(0)
    expect(result.funding_received).toBe(true)
    // Alias fast path: exit lands exactly at the funding event candle (nextFundingTime)
    expect(result.hold_duration).toBe(8 * 3600 + makeConfig().entry_offset_seconds)
  })

  it('exits DEADLINE when max_carry_funding_events is reached', () => {
    const strategy = new SpotFuturesStrategy()
    const cfg = makeConfig({ max_carry_funding_events: 2 })
    strategy.initialize(cfg, BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    // All events well above convergence threshold → no FUNDING_FLOOR exit
    const allFundingEvents = makeFundingEvents(triggerTime, TRIGGER_RATE, [TRIGGER_RATE, TRIGGER_RATE, TRIGGER_RATE])

    const widePostSeconds = cfg.max_carry_funding_events * 9 * 3600
    const perpWindow = buildWideWindow(triggerTime, basePrice, widePostSeconds)
    const spotWindow = buildWideWindow(triggerTime, basePrice, widePostSeconds)
    const perpEvent = makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })

    const result = strategy.executeSpotFutures(
      perpEvent,
      perpWindow,
      spotWindow,
      allFundingEvents,
      BINANCE_FEES,
      SPOT_FEE
    )

    expect(result).not.toBeNull()
    if (!result) throw new Error('expected result')

    expect(result.exit_reason).toBe('DEADLINE')
    expect(result.funding_events_collected).toBe(cfg.max_carry_funding_events)
    // Alias fast path: exit lands exactly at the 2nd funding event candle (triggerTime + 8h)
    expect(result.hold_duration).toBe(8 * 3600 + makeConfig().entry_offset_seconds)
  })

  it('rejects entry when expected profit < minTotalProfit (UNFILLED)', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig({ minTotalProfit: 0.1 }), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const allFundingEvents = makeFundingEvents(triggerTime, TRIGGER_RATE, [0.001])
    const perpWindow = buildWideWindow(triggerTime, 50000)
    const spotWindow = buildWideWindow(triggerTime, 50000)
    const perpEvent = makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })

    const result = strategy.executeSpotFutures(
      perpEvent,
      perpWindow,
      spotWindow,
      allFundingEvents,
      BINANCE_FEES,
      SPOT_FEE
    )

    expect(result).toBeNull()
  })

  it('T_exit_first gate: hold_duration >= one funding cycle even with tiny TP threshold', () => {
    const strategy = new SpotFuturesStrategy()
    // spreadTakeProfit so small it would fire immediately — but should be gated until T_exit_first
    strategy.initialize(makeConfig({ spreadTakeProfit: 0.000001 }), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const nextFundingTime = new Date(triggerTime.getTime() + 8 * 3600 * 1000)

    const allFundingEvents = [
      makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE }),
      makeFundingEvent({ fundingTime: nextFundingTime, fundingRate: 0.00015 }), // drops below threshold
    ]

    const perpWindow = buildWideWindow(triggerTime, basePrice)
    const spotWindow = buildWideWindow(triggerTime, basePrice)
    const perpEvent = makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })

    const result = strategy.executeSpotFutures(
      perpEvent,
      perpWindow,
      spotWindow,
      allFundingEvents,
      BINANCE_FEES,
      SPOT_FEE
    )

    expect(result).not.toBeNull()
    if (!result) throw new Error('expected result')

    // At least one funding event collected before gate opened
    expect(result.funding_events_collected).toBeGreaterThanOrEqual(1)
    // Hold duration >= one funding cycle minus small exit offset
    const minHoldSeconds = 8 * 3600 - 10
    expect(result.hold_duration).toBeGreaterThanOrEqual(minHoldSeconds)
  })

  it('shouldTrigger returns false for negative and sub-threshold funding', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const t = new Date('2025-06-01T00:00:00Z')
    expect(strategy.shouldTrigger(makeFundingEvent({ fundingTime: t, fundingRate: -0.01 }))).toBe(false)
    expect(strategy.shouldTrigger(makeFundingEvent({ fundingTime: t, fundingRate: 0.001 }))).toBe(false) // below F_threshold 0.0015
    expect(strategy.shouldTrigger(makeFundingEvent({ fundingTime: t, fundingRate: 0.0015 }))).toBe(true)
    expect(strategy.shouldTrigger(makeFundingEvent({ fundingTime: t, fundingRate: TRIGGER_RATE }))).toBe(true)
  })

  it('alias mode: spread_pnl ≈ 0 and net_pnl ≈ funding_pnl - fees', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const nextFundingTime = new Date(triggerTime.getTime() + 8 * 3600 * 1000)

    const allFundingEvents = [
      makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE }),
      makeFundingEvent({ fundingTime: nextFundingTime, fundingRate: 0.00015 }),
    ]

    const perpWindow = buildWideWindow(triggerTime, basePrice)
    const spotWindow = buildWideWindow(triggerTime, basePrice)
    const perpEvent = makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })

    const result = strategy.executeSpotFutures(
      perpEvent,
      perpWindow,
      spotWindow,
      allFundingEvents,
      BINANCE_FEES,
      SPOT_FEE
    )

    expect(result).not.toBeNull()
    if (!result) throw new Error('expected result')

    expect(Math.abs(result.pnl.spread_pnl)).toBeLessThan(0.001) // alias mode
    expect(Math.abs(result.pnl.delta_pnl)).toBeLessThan(TOLERANCE)

    const expectedFees = 2 * SPOT_FEE + 2 * BINANCE_FEES.taker_fee
    expect(Math.abs(result.pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)

    // net_pnl = spread_pnl + funding_pnl - fees ≈ funding_pnl - fees (spread ≈ 0)
    expect(Math.abs(result.pnl.net_pnl - (result.pnl.funding_pnl - expectedFees))).toBeLessThan(0.001)
  })

  it('returns null when no entry candle exists', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    // preFunding: 2 — T_entry = T_funding - 5s is outside the window
    const perpWindow = buildWindow({ fundingTime: triggerTime, basePrice: 50000, preFunding: 2 })
    const spotWindow = buildWindow({ fundingTime: triggerTime, basePrice: 50000, preFunding: 2 })
    const perpEvent = makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })
    const allFundingEvents = makeFundingEvents(triggerTime, TRIGGER_RATE, [0.001])

    const result = strategy.executeSpotFutures(
      perpEvent,
      perpWindow,
      spotWindow,
      allFundingEvents,
      BINANCE_FEES,
      SPOT_FEE
    )

    expect(result).toBeNull()
  })
})
