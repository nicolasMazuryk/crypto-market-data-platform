import { describe, it, expect } from 'vitest'
import { Strategy1Ws } from '../../strategies/strategy-1-ws.js'
import { buildWindow, makeFundingEvent, expectTrade, BINANCE_FEES } from './fixtures.js'
import { buildLookaheadContext } from '../../engine/localization.js'
import type { OHLCWindow, FundingEvent } from '../../data/types.js'

const DROP_PARAMS = { dropSearchWindowSeconds: 10, dropQualifierFundingMult: 0.5, dropQualifierRangeMult: 3.0 }

/** Build the engine-supplied lookahead context (drop localization + gated window). */
function ctx(window: OHLCWindow, event: FundingEvent) {
  return buildLookaheadContext(window, event.funding_time, event.funding_rate, DROP_PARAMS)
}

function makeStrategy(
  wsEventConfig: { missRate: number; extraDelaySeconds: number },
  overrides: Partial<{ entry_offset_seconds: number; funding_fee_timeout_seconds: number; orderLatencyMs: number }> = {}
) {
  const strategy = new Strategy1Ws()
  strategy.initialize(
    {
      strategy_id: 'strategy_1_ws',
      direction: 'long',
      negative_funding_threshold_percent: -0.4,
      entry_offset_seconds: overrides.entry_offset_seconds ?? 5,
      funding_fee_timeout_seconds: overrides.funding_fee_timeout_seconds ?? 30,
      amount_usd: 20,
      leverage: 4,
    },
    BINANCE_FEES,
    0,
    overrides.orderLatencyMs ?? 0,
    undefined,
    wsEventConfig
  )
  return strategy
}

describe('E2E: Strategy 1-WS — Funding-Fee-Event Exit', () => {
  it('Event path: exits at max(T_drop, T_settle) + extraDelaySeconds', () => {
    const strategy = makeStrategy({ missRate: 0, extraDelaySeconds: 2 })

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    const overrides = new Map<number, Partial<{ bidOpen: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 }) // entry candle
    overrides.set(4, { bidLow: 49600 }) // qualifying drop (0.8%) → localizes T_drop = T+4
    overrides.set(6, { bidOpen: 49700 }) // exit fill candle: T_drop(4) + extraDelay(2) = T+6

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = expectTrade(strategy.execute(event, window, ctx(window, event)))

    expect(result.exit_reason).toBe('funding_fee_event')
    expect(result.real_settlement_detected).toBe(true)
    expect(result.t_drop_offset_s).toBe(4)
    expect(result.exit_price).toBe(49700)

    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 6000)
  })

  it('Timeout path: forced miss exits at T_settle + funding_fee_timeout_seconds', () => {
    const strategy = makeStrategy({ missRate: 1, extraDelaySeconds: 2 }, { funding_fee_timeout_seconds: 30 })

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    const overrides = new Map<number, Partial<{ bidOpen: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 })
    overrides.set(4, { bidLow: 49600 }) // would localize T_drop = T+4, but timeout path ignores it
    overrides.set(30, { bidOpen: 49700 }) // exit fill candle: T_settle + timeout(30)

    const window = buildWindow({ fundingTime, basePrice, overrides, postFunding: 40 })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = expectTrade(strategy.execute(event, window, ctx(window, event)))

    expect(result.exit_reason).toBe('funding_fee_timeout')
    expect(result.exit_price).toBe(49700)

    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 30000)
  })

  it('No exit on drop_candle: clamps the event-path fill to drop_candle + 1s', () => {
    // extraDelaySeconds=0 → naive exit decision equals T_drop exactly (T+4). The structural
    // floor (§5.5.2) must bump the fill to T_drop + 1s (T+5), never the drop candle itself.
    const strategy = makeStrategy({ missRate: 0, extraDelaySeconds: 0 })

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    const overrides = new Map<number, Partial<{ bidOpen: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 })
    overrides.set(4, { bidLow: 49600 }) // localizes T_drop = T+4
    overrides.set(5, { bidOpen: 49700 }) // clamped exit fill candle: T_drop(4) + 1s

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = expectTrade(strategy.execute(event, window, ctx(window, event)))

    expect(result.t_drop_offset_s).toBe(4)
    expect(result.exit_price).toBe(49700)

    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 5000) // T+5, not T+4 (the drop candle)
    expect(exitMs).toBeGreaterThan(fundingTime.getTime() + 4000)
  })

  it('no_drop_localized: falls back to the window edge, event path keys off it', () => {
    // Flat candles throughout → no qualifying drop. tDropTs falls back to
    // T_settle + dropSearchWindowSeconds (T+10). Event path exits at T+10 + extraDelay(2) = T+12.
    const strategy = makeStrategy({ missRate: 0, extraDelaySeconds: 2 })

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const basePrice = 50000

    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: basePrice + 5 })
    for (let i = 0; i <= 10; i++) {
      overrides.set(i, { bidOpen: basePrice, bidHigh: basePrice + 5, bidLow: basePrice }) // flat
    }
    overrides.set(12, { bidOpen: 49900 })

    const window = buildWindow({ fundingTime, basePrice, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })

    const result = expectTrade(strategy.execute(event, window, ctx(window, event)))

    expect(result.real_settlement_detected).toBe(false)
    expect(result.t_drop_offset_s).toBeNull()
    expect(result.exit_reason).toBe('funding_fee_event')

    const entryMs = fundingTime.getTime() - 5000
    const exitMs = entryMs + result.hold_duration * 1000
    expect(exitMs).toBe(fundingTime.getTime() + 12000)
  })

  it('Multi-event: ws_event_miss_rate=0.01 fires the timeout path strictly > 0 times across a fleet of events', () => {
    const strategy = makeStrategy({ missRate: 0.01, extraDelaySeconds: 1 })

    const baseTime = new Date('2025-06-01T00:00:00Z').getTime()
    const N = 300
    let timeoutCount = 0
    let eventCount = 0

    for (let i = 0; i < N; i++) {
      const fundingTime = new Date(baseTime + i * 3600 * 1000)
      const window = buildWindow({ fundingTime, basePrice: 50000 }) // flat, no drop
      const event = makeFundingEvent({ fundingTime, fundingRate: -0.015 })
      const result = expectTrade(strategy.execute(event, window, ctx(window, event)))
      if (result.exit_reason === 'funding_fee_timeout') timeoutCount++
      if (result.exit_reason === 'funding_fee_event') eventCount++
    }

    expect(timeoutCount).toBeGreaterThan(0)
    expect(eventCount).toBeGreaterThan(0)
    expect(timeoutCount + eventCount).toBe(N)
  })
})
