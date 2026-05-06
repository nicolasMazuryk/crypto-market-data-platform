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
    minTotalProfit: 0.0005,
    fundingConvergenceThreshold: 0.0002,
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
  it('exits FUNDING_FLOOR after one cycle: peek-ahead skips the sub-threshold event', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const nextFundingTime = new Date(triggerTime.getTime() + 8 * 3600 * 1000)
    const belowThresholdRate = 0.00015 // below convergence threshold 0.0002

    const allFundingEvents = [
      makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE }),
      makeFundingEvent({ fundingTime: nextFundingTime, fundingRate: belowThresholdRate }),
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
    // Only the trigger event accrues — the sub-threshold event is never collected
    expect(result.funding_events_collected).toBe(1)
    expect(result.cumulative_funding_rate).toBeCloseTo(TRIGGER_RATE, 10)
    // Sub-threshold rate must NOT appear in funding_pnl
    expect(result.pnl.funding_pnl).toBeCloseTo(TRIGGER_RATE, 10)
    expect(Math.abs(result.pnl.spread_pnl)).toBeLessThan(0.001) // alias mode: spread = 0
    expect(result.funding_received).toBe(true)
    // hold_duration = (nextFundingTime - exit_offset) - (triggerTime - entry_offset) = 8h
    expect(result.hold_duration).toBe(8 * 3600)
  })

  it('carries multiple profitable events before hitting FUNDING_FLOOR', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const t1 = new Date(triggerTime.getTime() + 8 * 3600 * 1000) // above threshold
    const t2 = new Date(triggerTime.getTime() + 16 * 3600 * 1000) // below threshold → exit before this

    const allFundingEvents = [
      makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE }),
      makeFundingEvent({ fundingTime: t1, fundingRate: 0.003 }),
      makeFundingEvent({ fundingTime: t2, fundingRate: 0.00015 }),
    ]

    const perpWindow = buildWideWindow(triggerTime, basePrice, 18 * 3600)
    const spotWindow = buildWideWindow(triggerTime, basePrice, 18 * 3600)
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

    expect(result.exit_reason).toBe('FUNDING_FLOOR')
    // Trigger + t1 accrue; t2 is peeked and skipped
    expect(result.funding_events_collected).toBe(2)
    expect(result.pnl.funding_pnl).toBeCloseTo(TRIGGER_RATE + 0.003, 10)
    // hold_duration = (t2 - exit_offset) - (triggerTime - entry_offset) = 16h
    expect(result.hold_duration).toBe(16 * 3600)
  })

  it('returns null when all funding events remain above threshold (open at end of data)', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    // All future events above convergence threshold — no funding floor exit fires
    const allFundingEvents: FundingEvent[] = [
      makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE }),
    ]
    for (let i = 1; i <= 5; i++) {
      allFundingEvents.push(
        makeFundingEvent({
          fundingTime: new Date(triggerTime.getTime() + i * 8 * 3600 * 1000),
          fundingRate: TRIGGER_RATE,
        })
      )
    }

    const perpWindow = buildWideWindow(triggerTime, basePrice, 30)
    const spotWindow = buildWideWindow(triggerTime, basePrice, 30)
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
    expect(strategy.openAtEndCount).toBe(1)
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
    // openAtEndCount must NOT be incremented for entry rejections
    expect(strategy.openAtEndCount).toBe(0)
  })

  it('T_exit_first gate: hold_duration >= one funding cycle even with tiny TP threshold', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

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

    expect(result.funding_events_collected).toBe(1)
    // Hold duration = exactly 8h (trigger to next event, both offset-adjusted)
    expect(result.hold_duration).toBe(8 * 3600)
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

  it('alias mode: spread_pnl = 0 and net_pnl = funding_pnl - fees', () => {
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

    // F3: alias mid-price → spread_pnl = 0 exactly
    expect(result.pnl.spread_pnl).toBe(0)
    expect(Math.abs(result.pnl.delta_pnl)).toBeLessThan(TOLERANCE)

    const expectedFees = 2 * SPOT_FEE + 2 * BINANCE_FEES.taker_fee
    expect(Math.abs(result.pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)

    // Reconciliation: net_pnl = spread_pnl + funding_pnl - fees = funding_pnl - fees
    expect(Math.abs(result.pnl.net_pnl - (result.pnl.funding_pnl - expectedFees))).toBeLessThan(TOLERANCE)
    // Only trigger event accrued; next rate (0.00015) was peeked and not collected
    expect(result.pnl.funding_pnl).toBeCloseTo(TRIGGER_RATE, 10)
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
    expect(strategy.openAtEndCount).toBe(0)
  })

  it('openAtEndCount resets on re-initialize', () => {
    const strategy = new SpotFuturesStrategy()
    strategy.initialize(makeConfig(), BINANCE_FEES)

    const triggerTime = new Date('2025-06-01T00:00:00Z')
    const allFundingEvents = [makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })]
    const perpWindow = buildWideWindow(triggerTime, 50000, 30)
    const spotWindow = buildWideWindow(triggerTime, 50000, 30)
    const perpEvent = makeFundingEvent({ fundingTime: triggerTime, fundingRate: TRIGGER_RATE })

    strategy.executeSpotFutures(perpEvent, perpWindow, spotWindow, allFundingEvents, BINANCE_FEES, SPOT_FEE)
    expect(strategy.openAtEndCount).toBe(1)

    strategy.initialize(makeConfig(), BINANCE_FEES)
    expect(strategy.openAtEndCount).toBe(0)
  })
})
