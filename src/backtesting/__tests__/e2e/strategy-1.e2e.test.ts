import { describe, it, expect } from 'vitest'
import { Strategy1 } from '../../strategies/strategy-1.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES } from './fixtures.js'
import type { FundingSettlementConfig } from '../../config/schema.js'

const TOLERANCE = 1e-10

describe('E2E: Strategy 1 — Instant Exit', () => {
  const strategy = new Strategy1()
  strategy.initialize(
    {
      strategy_id: 'strategy_1',
      direction: 'long',
      negative_funding_threshold_percent: -0.4,
      entry_offset_seconds: 5,
      exit_offset_seconds: 2,
      funding_applied_on_same_second: false,
      amount_usd: 20,
      leverage: 4,
    },
    BINANCE_FEES,
    0
  )

  it('Scenario 1: Profitable — funding > drop + fees', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const entryPrice = 50000
    const exitBidOpen = 49925 // 0.15% drop

    // Entry at T-5: ask_open = 50005 (with spread)
    // Exit at T+2: bid_open = 49925
    const overrides = new Map<number, Partial<{ bidOpen: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: entryPrice + 5 }) // entry ask
    overrides.set(2, { bidOpen: exitBidOpen }) // exit bid

    const window = buildWindow({ fundingTime, basePrice: entryPrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    expect(strategy.shouldTrigger(event)).toBe(true)

    const result = strategy.execute(event, window)
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

    const overrides = new Map<number, Partial<{ bidOpen: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: entryPrice + 5 })
    overrides.set(2, { bidOpen: exitBidOpen })

    const window = buildWindow({ fundingTime, basePrice: entryPrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.005 }) // Only 0.5%

    const result = strategy.execute(event, window)
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

describe('E2E: Strategy 1 — Settlement Detection', () => {
  it('Scenario Settlement: exit anchored to detected settlement + exit_offset', () => {
    // Settlement detected at T+3 (big drop). exit_offset=2.
    // Expected exitTs = T+3+2 = T+5. Funding received since exitTs >= settlementTs.
    const settlementConfig: FundingSettlementConfig = {
      detection_window_seconds: 10,
      tp_post_settlement_buffer_seconds: 1,
    }
    const strat = new Strategy1()
    strat.initialize(
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        exit_offset_seconds: 2,
        funding_applied_on_same_second: false,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0,
      settlementConfig
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const exitBidOpen = 49950 // price at T+5

    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 }) // entry candle
    // T+3: big settlement drop
    overrides.set(3, { bidOpen: basePrice, bidHigh: basePrice + 10, bidLow: basePrice - 200 }) // drop=200 → settlement here
    overrides.set(5, { bidOpen: exitBidOpen }) // exit candle at T+3+2=T+5

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = strat.execute(event, window)
    if (!result) throw new Error('expected result')

    expect(result.real_settlement_detected).toBe(true)
    expect(result.real_settlement_ts).toBe(
      new Date(fundingTime.getTime() + 3000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
    )
    // Exit at T+5 (settlementTs T+3 + exit_offset 2)
    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 5000)
    // Funding received: entry(T-5) <= settlement(T+3) <= exit(T+5)
    expect(result.funding_received).toBe(true)
  })

  it('Scenario Settlement-Fallback: no drop detected → exit at T_funding + offset', () => {
    // All candles flat (bid_open == bid_low), no red candle → fallback to T_funding.
    const strat = new Strategy1()
    strat.initialize(
      {
        strategy_id: 'strategy_1',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        exit_offset_seconds: 2,
        funding_applied_on_same_second: false,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0,
      { detection_window_seconds: 10, tp_post_settlement_buffer_seconds: 1 }
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    // Override all candles in [T, T+10] to have bid_open == bid_low (flat/green)
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 })
    for (let i = 0; i <= 10; i++) {
      overrides.set(i, { bidOpen: basePrice, bidHigh: basePrice + 5, bidLow: basePrice }) // flat
    }

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = strat.execute(event, window)
    if (!result) throw new Error('expected result')

    expect(result.real_settlement_detected).toBe(false)
    expect(result.real_settlement_drop).toBeNull()
    // Falls back: exit at T+0+2 = T+2
    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 2000)
  })
})
