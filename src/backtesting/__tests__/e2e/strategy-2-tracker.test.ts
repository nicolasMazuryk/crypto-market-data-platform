import { describe, it, expect } from 'vitest'
import { Strategy2 } from '../../strategies/strategy-2.js'
import { buildWindow, makeFundingEvent, BINANCE_FEES } from './fixtures.js'
import { buildLookaheadContext } from '../../engine/localization.js'
import type { OHLCWindow, FundingEvent } from '../../data/types.js'
import type { Strategy2Config } from '../../config/schema.js'

const DROP_PARAMS = { dropSearchWindowSeconds: 10, dropQualifierFundingMult: 0.5, dropQualifierRangeMult: 3.0 }

function ctx(window: OHLCWindow, event: FundingEvent) {
  return buildLookaheadContext(window, event.funding_time, event.funding_rate, DROP_PARAMS)
}

const BASE_CONFIG: Strategy2Config = {
  strategy_id: 'strategy_2',
  direction: 'long',
  negative_funding_threshold_percent: -0.4,
  entry_offset_seconds: 5,
  funding_fee_timeout_seconds: 30,
  retracement_pct: 0.5,
  deadline_seconds: 60,
  sl_multiplier: 1.0,
  amount_usd: 20,
  leverage: 4,
}

describe('Strategy 2 tracker — causal arming + anchor', () => {
  it('ignores a low printed before T_drop arms the tracker', () => {
    // T_drop localizes at T+4. A spurious low at T+1 (before arming) is deeper than the
    // T_settle (T+0) low but shallower than the drop candle's own low — under the pre-fix
    // gate (`row.ts >= fundingTs`) it would win and drag pTarget down; under the fix it's
    // never seen by the tracker.
    const strategy = new Strategy2()
    strategy.initialize(BASE_CONFIG, BINANCE_FEES, 0, 0)

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: 50005, bidOpen: 50000 }) // entry-decision candle; anchor = 50000
    overrides.set(0, { bidOpen: 49800, bidLow: 49760 })
    overrides.set(1, { bidOpen: 49700, bidLow: 49560 }) // deep spurious low, pre-arming — must be ignored
    overrides.set(2, { bidOpen: 49750, bidLow: 49700 })
    overrides.set(3, { bidOpen: 50000, bidLow: 49745 })
    overrides.set(4, { bidOpen: 50000, bidHigh: 50100, bidLow: 49700 }) // T_drop localizes here; first post-arm low
    overrides.set(5, { bidOpen: 49850, bidHigh: 49900, bidLow: 49800 }) // not lower than 49700 — no P_low update

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.t_drop_offset_s).toBe(4)
    expect(result.exit_reason).toBe('tp_hit')
    // P_low = 49700 (T+4, first low seen at/after arming), NOT 49560 (T+1, pre-arming).
    // pTarget = 49700 + (50000 - 49700) * 0.5 = 49850. The pre-fix bug would have produced
    // 49560 + (50000 - 49560) * 0.5 = 49780 instead.
    expect(result.exit_price).toBeCloseTo(49850, 6)
  })

  it('anchors the retracement target to the entry-decision candle, not the T_settle candle', () => {
    const strategy = new Strategy2()
    strategy.initialize(BASE_CONFIG, BINANCE_FEES, 0, 0)

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    // Entry-decision candle (T-5): bid_open = 50200 (the anchor).
    overrides.set(-5, { bidOpen: 50200, askOpen: 50205 })
    // T_settle candle: bid_open = 50000 — deliberately different from the entry candle, so a
    // regression back to anchoring here would move pTarget.
    overrides.set(0, { bidOpen: 50000, bidLow: 49990 })
    overrides.set(1, { bidOpen: 49900, bidLow: 49850 })
    overrides.set(2, { bidOpen: 49950, bidLow: 49900 })
    overrides.set(3, { bidOpen: 50100, bidLow: 49950 })
    overrides.set(4, { bidOpen: 50100, bidHigh: 50300, bidLow: 49750 }) // T_drop localizes here
    overrides.set(5, { bidOpen: 50000, bidHigh: 50250, bidLow: 49800 }) // not lower — P_low stays 49750

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.t_drop_offset_s).toBe(4)
    expect(result.exit_reason).toBe('tp_hit')
    // P_low = 49750 (T+4). anchor = entry candle's bid_open (50200), not the T_settle
    // candle's (50000).
    // pTarget = 49750 + (50200 - 49750) * 0.5 = 49975. Anchoring on the T_settle candle
    // instead would have produced 49750 + (50000 - 49750) * 0.5 = 49875.
    expect(result.exit_price).toBeCloseTo(49975, 6)
  })

  it('arms at T_settle + funding_fee_timeout_seconds on a WS-miss draw', () => {
    const strategy = new Strategy2()
    strategy.initialize(BASE_CONFIG, BINANCE_FEES, 0, 0, undefined, { missRate: 1, extraDelaySeconds: 2 })

    const fundingTime = new Date('2025-06-01T00:00:00Z')
    // Flat price window (no qualifying drop candle within the search window) — the miss draw
    // forces the timeout arming path regardless of T_drop localization.
    // funding_fee_timeout_seconds = 30 → arming at T+30.
    const overrides = new Map<number, Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number }>>()
    overrides.set(-5, { askOpen: 50005, bidOpen: 50000 })
    overrides.set(15, { bidLow: 49550 }) // deep low before T+30 arming — must be ignored
    // Zero-spread flat candles right around arming so no premature (shallow) P_low/TP gets
    // set before the real T+35 low — a nonzero default spread here would arm the tracker on
    // the T+30 candle's shallow low and fire the resulting near-anchor TP immediately.
    for (let offset = 30; offset <= 34; offset++) {
      overrides.set(offset, { bidOpen: 50000, bidHigh: 50000, bidLow: 50000 })
    }
    overrides.set(35, { bidOpen: 49700, bidLow: 49700 }) // first low seen at/after arming
    overrides.set(36, { bidOpen: 49900, bidHigh: 50100, bidLow: 49850 }) // recovers through pTarget

    const window = buildWindow({ fundingTime, basePrice: 50000, overrides })
    const event = makeFundingEvent({ fundingTime, fundingRate: -0.01 })
    const result = strategy.execute(event, window, ctx(window, event))

    if (!result) throw new Error('expected result')
    expect(result.exit_reason).toBe('tp_hit')
    // anchor = entry candle bid_open = 50000. P_low = 49700 (T+35), NOT 49550 (T+15,
    // pre-arming). pTarget = 49700 + (50000 - 49700) * 0.5 = 49850.
    expect(result.exit_price).toBeCloseTo(49850, 6)
  })
})
