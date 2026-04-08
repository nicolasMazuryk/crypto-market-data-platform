import { describe, it, expect } from 'vitest'
import { Strategy3 } from '../../strategies/strategy-3.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES, DEFAULT_SLIPPAGE } from './fixtures.js'

describe('E2E: Strategy 3 — Ride the Drop', () => {
  it('Scenario 5: TP hit before SL (variant A)', () => {
    const strategy = new Strategy3('strategy_3a')
    strategy.initialize(
      {
        strategy_id: 'strategy_3a',
        direction: 'short',
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        stop_loss: 0.01,
        tp_mode: 'A',
        tp_multiplier: 1.5,
        tp_addend: 0.004,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // Entry: SELL at bid_open at T-5 = 50000
    // F = 1%, TP_A = F * 1.5 = 1.5%, TP price = 50000 * (1 - 0.015) = 49250
    // Price drops to 49200 at T+5 → TP should hit

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < 0) return 50000
        return 50000 - offset * 160 // drops fast
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    expect(strategy.shouldTrigger(event)).toBe(true)

    const result = strategy.execute(event, window)
    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('TP_HIT')
    expect(result.pnl.funding_pnl).toBeLessThan(0) // Shorts pay funding
    expect(result.funding_received).toBe(false)
  })

  it('Scenario 6: SL hit before TP', () => {
    const strategy = new Strategy3('strategy_3a')
    strategy.initialize(
      {
        strategy_id: 'strategy_3a',
        direction: 'short',
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        stop_loss: 0.01,
        tp_mode: 'A',
        tp_multiplier: 1.5,
        tp_addend: 0.004,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // Entry: SELL at 50000
    // SL = 50000 * (1 + 0.01) = 50500
    // Price goes UP instead of down → SL hit

    const window = buildWindow({
      fundingTime,
      basePrice: 50000,
      priceFn: offset => {
        if (offset < 0) return 50000
        return 50000 + offset * 100 // Price goes up
      },
    })

    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window)

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('SL_HIT')
    expect(result.pnl.net_pnl).toBeLessThan(0)
  })

  it('Scenario 7: Both SL and TP possible in same candle — worst-case (SL) applied', () => {
    const strategy = new Strategy3('strategy_3a')
    strategy.initialize(
      {
        strategy_id: 'strategy_3a',
        direction: 'short',
        funding_threshold: 0.004,
        entry_offset_seconds: 5,
        stop_loss: 0.01,
        tp_mode: 'A',
        tp_multiplier: 1.5,
        tp_addend: 0.004,
      },
      BINANCE_FEES,
      DEFAULT_SLIPPAGE
    )

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // Entry SELL at 50000
    // SL price = 50500, TP price = 49250 (F=1%, TP=1.5%)
    // Create a candle where both could trigger:
    // ask_high >= 50500 (SL) AND ask_low < 49250 (TP)

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
    overrides.set(-5, { bidOpen: 50000 }) // Entry
    overrides.set(1, {
      askOpen: 50000,
      askHigh: 50600, // Triggers BUY STOP SL
      askLow: 49200, // Triggers BUY LIMIT TP
      bidOpen: 50000,
      bidHigh: 50600,
      bidLow: 49200,
    })

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })

    const result = strategy.execute(event, window)
    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('SL_HIT') // Worst case
  })
})
