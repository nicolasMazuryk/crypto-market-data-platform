import { describe, it, expect } from 'vitest'
import { Strategy41 } from '../../strategies/strategy-4-1.js'
import { Strategy42 } from '../../strategies/strategy-4-2.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES, DEFAULT_SLIPPAGE } from './fixtures.js'

const TOLERANCE = 1e-10

describe('E2E: Strategy 4.1 — Ladder LONG', () => {
  it('Scenario 8: Partial ladder fill (3 of 5 orders)', () => {
    const strategy = new Strategy41('strategy_4_1a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_1a',
        direction: 'long',
        negative_funding_threshold_percent: -0.6,
        entry_offset_seconds: 5,
        ladder_count: 5,
        ladder_top_mult: 0.4,
        ladder_bottom_mult: 1.5,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5, // slPrice ≈ pAvg * 0.985 ≈ 48922 — far below test minimum of 49400
        amount_usd: 20,
        leverage: 4,
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
    const expectedFees = result.fill_count * 0.0002 + (result.exit_reason === 'tp_hit' ? 0.0002 : 0.0004)
    expect(Math.abs(result.pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)
  })

  it('Scenario 9: No fills (price doesnt drop enough)', () => {
    const strategy = new Strategy41('strategy_4_1a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_1a',
        direction: 'long',
        negative_funding_threshold_percent: -0.6,
        entry_offset_seconds: 5,
        ladder_count: 5,
        ladder_top_mult: 0.4,
        ladder_bottom_mult: 1.5,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
        amount_usd: 20,
        leverage: 4,
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
    // Ladder placed but no rung filled → representable §12.2 terminal, not a data-absence null.
    expect(result).toEqual({ error_code: 'ladder_no_fills' })
  })

  it('Scenario SL 4.1: SL triggered after ladder fills', () => {
    // 2-order ladder: both fill, then price drops through slPrice → sl_hit
    // F = -0.01, pCurrent ≈ 50005
    // ladderTop = 50005 * 0.996 = 49804.98 (top_mult=0.4)
    // ladderBottom = 50005 * 0.99 = 49504.95 (bottom_mult=1.0)
    // pAvg ≈ 49654.97, slPrice ≈ 49654.97 * 0.985 ≈ 48910
    const strategy = new Strategy41('strategy_4_1a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_1a',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        ladder_count: 2,
        ladder_top_mult: 0.4,
        ladder_bottom_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
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
        if (offset < 0) return 50000
        if (offset <= 5) return 50000 - offset * 120 // drops to 49400 at T+5 (fills both orders)
        return 49400 - (offset - 5) * 200 // continues dropping sharply below slPrice ~48910
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('sl_hit')
    expect(result.pnl.net_pnl).toBeLessThan(0)
    // Exit qty = totalQty (both orders filled)
    expect(result.fill_count).toBe(2)
  })

  it('Scenario SL+TP same-candle 4.1: SL wins on worst-case ambiguity', () => {
    // After the last ladder fill, the first post-fill candle spikes both
    // bid_low <= slPrice and bid_high >= tpPrice → worst-case: SL wins
    const strategy = new Strategy41('strategy_4_1a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_1a',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        ladder_count: 2,
        ladder_top_mult: 0.4,
        ladder_bottom_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // pAvg ≈ 49654.97, slPrice ≈ 48910, tpPrice ≈ 49754
    // Override offset 6 (first post-fill candle) with a wide spike:
    //   bid_low = 48700 <= 48910 (SL trigger)
    //   bid_high = 49900 >= 49754 (TP trigger)
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number }>>()
    overrides.set(6, { bidOpen: 49300, bidHigh: 49900, bidLow: 48700 })

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      overrides,
      priceFn: offset => {
        if (offset < 0) return 50000
        if (offset <= 5) return 50000 - offset * 120 // drops to 49400, fills both orders at offset 5
        return 49300 // flat after fills (override at offset 6 drives the spike)
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('sl_hit')
  })

  it('Scenario deadline 4.1: SL and TP both miss, deadline exit', () => {
    // After ladder fills, price stays between slPrice and tpPrice throughout the window
    const strategy = new Strategy41('strategy_4_1a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_1a',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        ladder_count: 2,
        ladder_top_mult: 0.4,
        ladder_bottom_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // pAvg ≈ 49654.97, slPrice ≈ 48910, tpPrice ≈ 49754
    // Price drops to fill ladder then sits at 49200 — below tpPrice, above slPrice

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < 0) return 50000
        if (offset <= 5) return 50000 - offset * 120 // drops to 49400 (fills orders)
        return 49200 // sits between slPrice ~48910 and tpPrice ~49754 → no exit
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('deadline')
  })
})

describe('E2E: Strategy 4.2 — Single Limit LONG', () => {
  it('Scenario 10: Limit filled, TP hit', () => {
    const strategy = new Strategy42('strategy_4_2a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        negative_funding_threshold_percent: -0.6,
        entry_offset_seconds: 5,
        limit_offset_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5, // slPrice ≈ entryFill * 0.985 ≈ 48763 — far below test minimum ~49400
        amount_usd: 20,
        leverage: 4,
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
    expect(result.exit_reason).toBe('tp_hit')
    expect(result.pnl.funding_pnl).toBe(0) // Scenario a
  })

  it('Scenario 11: Limit not filled', () => {
    const strategy = new Strategy42('strategy_4_2a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        negative_funding_threshold_percent: -0.6,
        entry_offset_seconds: 5,
        limit_offset_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
        amount_usd: 20,
        leverage: 4,
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
    // Entry limit never filled → representable §12.2 terminal, not a data-absence null.
    expect(result).toEqual({ error_code: 'limit_expired' })
  })

  it('Scenario SL 4.2: SL triggered after limit fill', () => {
    // Limit fills when price drops below limitPrice, then drops further through slPrice
    // F = -0.01, pCurrent ≈ 50005
    // limitPrice = 50005 * 0.99 = 49504.95
    // entryFill.price = 49504.95
    // slPrice = 49504.95 * (1 - 0.01 * 1.5) = 49504.95 * 0.985 ≈ 48762
    const strategy = new Strategy42('strategy_4_2a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        negative_funding_threshold_percent: -0.6,
        entry_offset_seconds: 5,
        limit_offset_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
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
        if (offset < 0) return 50000
        if (offset <= 5) return 50000 - offset * 120 // drops to 49400 at T+5 (fills limit)
        return 49400 - (offset - 5) * 200 // continues dropping sharply below slPrice ~48762
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('sl_hit')
    expect(result.pnl.net_pnl).toBeLessThan(0)
  })

  it('Scenario SL+TP same-candle 4.2: SL wins on worst-case ambiguity', () => {
    // After limit fills, the very next candle has bid_low <= slPrice AND bid_high >= tpPrice
    // Worst-case rule: SL wins
    // entryFill.price ≈ 49504.95, slPrice ≈ 48762, tpPrice ≈ 49604.96
    const strategy = new Strategy42('strategy_4_2a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        negative_funding_threshold_percent: -0.6,
        entry_offset_seconds: 5,
        limit_offset_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // Limit fills at offset 5 when price drops to 49400.
    // Override offset 6 (first post-entry candle) with a spike that triggers both SL and TP:
    //   bid_low = 48700 <= slPrice 48762
    //   bid_high = 49700 >= tpPrice 49605
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number }>>()
    overrides.set(6, { bidOpen: 49100, bidHigh: 49700, bidLow: 48700 })

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      overrides,
      priceFn: offset => {
        if (offset < 0) return 50000
        if (offset <= 5) return 50000 - offset * 120 // fills limit at offset 5
        return 49100 // flat (override at offset 6 drives the spike)
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('sl_hit')
  })

  it('Scenario deadline 4.2: SL and TP both miss, deadline exit', () => {
    // After limit fills, price stays between slPrice and tpPrice throughout
    // entryFill.price ≈ 49504.95, slPrice ≈ 48762, tpPrice ≈ 49605
    // Price sits at 49100: bid_low ~49095 > 48762 (no SL), bid_high ~49105 < 49605 (no TP)
    const strategy = new Strategy42('strategy_4_2a')
    strategy.initialize(
      {
        strategy_id: 'strategy_4_2a',
        direction: 'long',
        negative_funding_threshold_percent: -0.6,
        entry_offset_seconds: 5,
        limit_offset_mult: 1.0,
        take_profit_pct: 0.2,
        deadline_seconds: 60,
        funding_applied_on_same_second: false,
        sl_multiplier: 1.5,
        amount_usd: 20,
        leverage: 4,
      },
      BINANCE_FEES,
      0
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < 0) return 50000
        if (offset <= 5) return 50000 - offset * 120 // drops to fill limit at offset 5
        return 49100 // stays between slPrice ~48762 and tpPrice ~49605
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('deadline')
  })
})
