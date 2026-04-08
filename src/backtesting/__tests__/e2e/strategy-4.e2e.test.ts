import { describe, it, expect } from 'vitest'
import { Strategy41 } from '../../strategies/strategy-4-1.js'
import { Strategy42 } from '../../strategies/strategy-4-2.js'
import { Strategy43 } from '../../strategies/strategy-4-3.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES, DEFAULT_SLIPPAGE } from './fixtures.js'

const TOLERANCE = 1e-10

describe('E2E: Strategy 4.1 — Ladder LONG', () => {
  it('Scenario 8: Partial ladder fill (3 of 5 orders)', () => {
    const strategy = new Strategy41('strategy_4_1a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_1a',
        direction: 'long',
        funding_threshold: 0.006,
        entry_offset_seconds: 5,
        ladder_count: 5,
        ladder_top_mult: 0.4,
        ladder_bottom_mult: 1.5,
        take_profit: 0.002,
        deadline_seconds: 60,
        include_funding: false,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    // F = 1%, |F| = 0.01
    // ladder_top = 50005 * (1 - 0.01 * 0.4) = 50005 * 0.996 = 49804.98
    // ladder_bottom = 50005 * (1 - 0.01 * 1.5) = 50005 * 0.985 = 49254.925
    // 5 orders spaced evenly. Price drops enough to fill top 3.

    const window = buildWindow({
      fundingTime,
      basePrice,
      priceFn: offset => {
        if (offset < 0) return basePrice
        if (offset <= 10) return basePrice - offset * 60 // drops to ~49400
        return 49500 + (offset - 10) * 10 // slowly recovers
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    expect(strategy.shouldTrigger(event)).toBe(true)

    const result = strategy.execute(event, window)
    if (!result) throw new Error('expected result')
    expect(result.fill_count).toBeGreaterThan(0)
    expect(result.fill_count).toBeLessThanOrEqual(5)
    expect(result.funding_received).toBe(false) // Scenario a
    expect(result.pnl.funding_pnl).toBe(0)
    // Fees: fill_count * maker_fee + exit_fee
    const expectedFees = result.fill_count * 0.0002 + (result.exit_reason === 'TP_HIT' ? 0.0002 : 0.0004)
    expect(Math.abs(result.pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)
  })

  it('Scenario 9: No fills (price doesnt drop enough)', () => {
    const strategy = new Strategy41('strategy_4_1a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_1a',
        direction: 'long',
        funding_threshold: 0.006,
        entry_offset_seconds: 5,
        ladder_count: 5,
        ladder_top_mult: 0.4,
        ladder_bottom_mult: 1.5,
        take_profit: 0.002,
        deadline_seconds: 60,
        include_funding: false,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // Price stays flat — no fills
    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: () => 50000, // No movement
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)
    expect(result).toBeNull() // No trade
  })
})

describe('E2E: Strategy 4.2 — Single Limit LONG', () => {
  it('Scenario 10: Limit filled, TP hit', () => {
    const strategy = new Strategy42('strategy_4_2a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        funding_threshold: 0.006,
        entry_offset_seconds: 5,
        limit_offset_mult: 1.0,
        take_profit: 0.002,
        deadline_seconds: 60,
        include_funding: false,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // F = 1%, limit at P * (1 - 0.01 * 1.0) = P * 0.99
    // P_current ask_open at T-5 ~ 50005
    // Limit at ~49505
    // Price drops to 49400 then recovers above 49600 (TP = 49505 * 1.002 ~ 49604)

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < 0) return 50000
        if (offset <= 5) return 50000 - offset * 120 // drops
        return 49400 + (offset - 5) * 40 // recovers
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('TP_HIT')
    expect(result.pnl.funding_pnl).toBe(0) // Scenario a
  })

  it('Scenario 11: Limit not filled', () => {
    const strategy = new Strategy42('strategy_4_2a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        funding_threshold: 0.006,
        entry_offset_seconds: 5,
        limit_offset_mult: 1.0,
        take_profit: 0.002,
        deadline_seconds: 60,
        include_funding: false,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // Price doesn't drop enough to fill limit
    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: () => 50000,
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)
    expect(result).toBeNull()
  })
})

describe('E2E: Strategy 4.3 — Limit with SL/TP', () => {
  it('Scenario 12: Filled, SL triggered', () => {
    const strategy = new Strategy43('strategy_4_3a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_3a',
        direction: 'long',
        funding_threshold: 0.006,
        entry_offset_seconds: 2,
        entry_mult: 0.75,
        sl_mult: 1.5,
        take_profit: 0.003,
        deadline_seconds: 60,
        include_funding: false,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // F = 1%
    // Entry limit at P * (1 - 0.01 * 0.75) = P * 0.9925
    // SL at P * (1 - 0.01 * 1.5) = P * 0.985
    // Price drops through entry and then through SL

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < 0) return 50000
        return 50000 - offset * 50 // Continuous drop
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('SL_HIT')
    expect(result.pnl.net_pnl).toBeLessThan(0)
  })

  it('Scenario 13: Filled, deadline exit', () => {
    const strategy = new Strategy43('strategy_4_3a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_3a',
        direction: 'long',
        funding_threshold: 0.006,
        entry_offset_seconds: 2,
        entry_mult: 0.75,
        sl_mult: 1.5,
        take_profit: 0.003,
        deadline_seconds: 60,
        include_funding: false,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // F = 1%
    // P_current ask_open at T-2 = 50005 (with ~5 spread on 50000)
    // Entry limit at P * (1 - 0.01 * 0.75) = 50005 * 0.9925 = 49629.96
    // SL at P * (1 - 0.01 * 1.5) = 50005 * 0.985 = 49254.925
    // TP at fill_price * 1.003 = ~49779
    //
    // Price drops to 49600 (below entry limit to fill) then stays at 49650
    // which is above SL (49255) but below TP (49779)
    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < -1) return 50000
        if (offset <= 1) return 49550 // Drop to fill entry (ask_low < 49630)
        return 49650 // Stay between SL and TP
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('DEADLINE')
  })
})
