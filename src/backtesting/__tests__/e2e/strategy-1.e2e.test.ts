import { describe, it, expect } from 'vitest'
import { Strategy1 } from '../../strategies/strategy-1.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES } from './fixtures.js'

const TOLERANCE = 1e-10

describe('E2E: Strategy 1 — Instant Exit', () => {
  const strategy = new Strategy1()
  strategy.initialize(
    {
      strategy_id: 'strategy_1',
      direction: 'long',
      funding_threshold: 0.004,
      entry_offset_seconds: 5,
      exit_offset_seconds: 2,
      funding_applied_on_same_second: false,
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
    expect(result.exit_reason).toBe('MARKET_EXIT')
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
