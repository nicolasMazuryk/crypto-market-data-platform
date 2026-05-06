import { describe, it, expect } from 'vitest'
import { Strategy5 } from '../../strategies/strategy-5.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES } from './fixtures.js'

const TOLERANCE = 1e-10

const BASE_CONFIG = {
  strategy_id: 'strategy_5' as const,
  direction: 'short' as const,
  main_exchange: 'binance',
  exclude_exchanges: [],
  main_exchange_funding_threshold: 0.005,
  min_funding_spread: 0.001,
  stop_loss: 0.005,
  tp_multiplier: 1.5,
  entry_offset_seconds: 3,
  deadline_seconds: 60,
  funding_applied_on_same_second: true,
}

describe('E2E: Strategy 5 — Main-Exchange-Driven Cross-Exchange Short', () => {
  it('Scenario A: TP hit — main deep negative, target less negative, price drops to TP', () => {
    const strategy = new Strategy5()
    strategy.initialize(BASE_CONFIG, BINANCE_FEES)

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000
    const mainFundingRate = -0.02 // -2% on main exchange
    const targetFundingRate = -0.003 // -0.3% on target exchange

    // tpDistance = |mainFundingRate| * tp_multiplier = 0.02 * 1.5 = 0.03
    // tpPrice = entryPrice * (1 - 0.03)
    const entryBidOpen = basePrice
    const tpDistance = Math.abs(mainFundingRate) * BASE_CONFIG.tp_multiplier // 0.03
    const tpPrice = entryBidOpen * (1 - tpDistance) // 50000 * 0.97 = 48500
    const _slPrice = entryBidOpen * (1 + BASE_CONFIG.stop_loss) // 50000 * 1.005 = 50250

    const overrides = new Map<number, Partial<{ bidOpen: number; askOpen: number; askLow: number }>>()
    overrides.set(-3, { bidOpen: entryBidOpen, askOpen: entryBidOpen + 5 })
    // TP is BUY LIMIT: fills when ask_low <= tpPrice
    overrides.set(5, { askLow: tpPrice - 1 })

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: targetFundingRate, exchange: 'bybit' })

    const result = strategy.executeMainExchange(
      event,
      window,
      mainFundingRate,
      targetFundingRate,
      fundingTime,
      BINANCE_FEES
    )
    if (!result) throw new Error('expected result')

    // SHORT: DELTA_PNL = (P_entry - P_exit) / P_entry
    const expectedDelta = (entryBidOpen - tpPrice) / entryBidOpen
    // Shorts pay funding on target: FUNDING_PNL = -|F_target|
    const expectedFunding = -Math.abs(targetFundingRate)
    // Entry taker + exit maker (TP is limit)
    const expectedFees = BINANCE_FEES.taker_fee + BINANCE_FEES.maker_fee
    const expectedNet = expectedDelta + expectedFunding - expectedFees

    expect(result.exit_reason).toBe('TP_HIT')
    expect(Math.abs(result.pnl.delta_pnl - expectedDelta)).toBeLessThan(TOLERANCE)
    expect(Math.abs(result.pnl.funding_pnl - expectedFunding)).toBeLessThan(TOLERANCE)
    expect(Math.abs(result.pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)
    expect(Math.abs(result.pnl.net_pnl - expectedNet)).toBeLessThan(TOLERANCE)
    expect(result.pnl.net_pnl).toBeGreaterThan(0)
    expect(result.funding_received).toBe(true)
    expect(result.exchange).toBe('bybit')
    expect(result.entry_price).toBeCloseTo(entryBidOpen, 6)
    expect(result.exit_price).toBeCloseTo(tpPrice, 6)
  })

  it('Scenario B: SL hit — price rises after entry, stop loss fires', () => {
    const strategy = new Strategy5()
    strategy.initialize(BASE_CONFIG, BINANCE_FEES)

    const fundingTime = new Date('2025-06-01T08:00:00Z')
    const basePrice = 40000
    const mainFundingRate = -0.01 // -1% on main exchange
    const targetFundingRate = -0.002 // -0.2% on target exchange

    // slPrice = entryPrice * (1 + stop_loss) = 40000 * 1.005 = 40200
    const entryBidOpen = basePrice
    const slPrice = entryBidOpen * (1 + BASE_CONFIG.stop_loss)

    const overrides = new Map<number, Partial<{ bidOpen: number; askOpen: number; askHigh: number }>>()
    overrides.set(-3, { bidOpen: entryBidOpen, askOpen: entryBidOpen + 4 })
    // SL is BUY STOP: fills when ask_high >= slPrice
    overrides.set(3, { askHigh: slPrice + 1 })

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: targetFundingRate, exchange: 'okx' })

    const result = strategy.executeMainExchange(
      event,
      window,
      mainFundingRate,
      targetFundingRate,
      fundingTime,
      BINANCE_FEES
    )
    if (!result) throw new Error('expected result')

    expect(result.exit_reason).toBe('SL_HIT')
    expect(result.exit_price).toBeGreaterThan(entryBidOpen)
    expect(result.pnl.net_pnl).toBeLessThan(0) // Loss
    expect(result.exchange).toBe('okx')
  })

  it('Scenario C: DEADLINE — price drifts sideways, forced market exit', () => {
    const strategy = new Strategy5()
    strategy.initialize(BASE_CONFIG, BINANCE_FEES)

    const fundingTime = new Date('2025-06-01T16:00:00Z')
    const basePrice = 30000
    const mainFundingRate = -0.006 // -0.6% on main exchange
    const targetFundingRate = -0.001 // -0.1% on target exchange

    // tpDistance = 0.006 * 1.5 = 0.009; tpPrice = 30000 * 0.991 = 29730
    // slPrice = 30000 * 1.005 = 30150
    // Price stays sideways at basePrice — neither TP nor SL hit

    const window = buildWindow({ fundingTime, basePrice })
    const event = makeFundingEvent({ fundingTime, fundingRate: targetFundingRate, exchange: 'gateio' })

    const result = strategy.executeMainExchange(
      event,
      window,
      mainFundingRate,
      targetFundingRate,
      fundingTime,
      BINANCE_FEES
    )
    if (!result) throw new Error('expected result')

    expect(result.exit_reason).toBe('DEADLINE')
    expect(result.exchange).toBe('gateio')
    // Hold duration should be roughly entry_offset_seconds + deadline_seconds
    const expectedMaxDuration = BASE_CONFIG.entry_offset_seconds + BASE_CONFIG.deadline_seconds + 2
    expect(result.hold_duration).toBeLessThanOrEqual(expectedMaxDuration)
  })

  it('Scenario D: Target funding fires before entry — funding must NOT be applied', () => {
    // Main fires at T=0, entry is at T-3s.
    // Target fires at T-30s (30s before main, within 60s tolerance).
    // Since target's funding event happened BEFORE the position was open, funding should NOT apply.
    const strategy = new Strategy5()
    strategy.initialize(BASE_CONFIG, BINANCE_FEES)

    const mainFundingTime = new Date('2025-06-02T00:00:00Z')
    // Target fired 30s earlier
    const targetFundingTime = new Date(mainFundingTime.getTime() - 30_000)
    const basePrice = 20000
    const mainFundingRate = -0.015
    const targetFundingRate = -0.002

    // entry = mainFundingTime - 3s = T-3s; targetFundingTime = T-30s (before entry)
    const event = makeFundingEvent({
      fundingTime: mainFundingTime,
      fundingRate: targetFundingRate,
      exchange: 'bybit',
    })
    const window = buildWindow({ fundingTime: mainFundingTime, basePrice })

    const result = strategy.executeMainExchange(
      event,
      window,
      mainFundingRate,
      targetFundingRate,
      targetFundingTime,
      BINANCE_FEES
    )
    if (!result) throw new Error('expected result')

    // Target's funding tick was at T-30s, BEFORE the position opened at T-3s
    expect(result.funding_received).toBe(false)
    expect(result.pnl.funding_pnl).toBe(0)
  })
})
