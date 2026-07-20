import { describe, it, expect } from 'vitest'
import { OHLCWindow } from './types.js'
import { detectRealFundingSettlement } from './funding-settlement.js'
import type { DropDetectionParams } from './funding-settlement.js'
import type { OrderbookRow } from '../../db/types.js'
import { toClickHouseDateTime } from '../../db/types.js'

interface CandleSpec {
  offset: number
  bidOpen: number
  bidHigh: number
  bidLow: number
  bidClose: number
}

function makeRow(fundingTime: Date, s: CandleSpec): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts: toClickHouseDateTime(new Date(fundingTime.getTime() + s.offset * 1000)),
    bid_open: s.bidOpen,
    bid_high: s.bidHigh,
    bid_low: s.bidLow,
    bid_close: s.bidClose,
    ask_open: s.bidOpen + 1,
    ask_high: s.bidHigh + 1,
    ask_low: s.bidLow + 1,
    ask_close: s.bidClose + 1,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
  }
}

/** Pre-settle rows [-30..-1] with a fixed 1s range% (for R_pre) and flat close = open = 100. */
function preRows(rangePct: number): CandleSpec[] {
  const half = ((rangePct / 100) * 100) / 2 // rangePct% of price(100), split around open
  const specs: CandleSpec[] = []
  for (let o = -30; o <= -1; o++) {
    specs.push({ offset: o, bidOpen: 100, bidHigh: 100 + half, bidLow: 100 - half, bidClose: 100 })
  }
  return specs
}

/** Flat filler candle (drop_move 0, red_range 0), keeps the prev_close chain contiguous. */
function flat(offset: number): CandleSpec {
  return { offset, bidOpen: 100, bidHigh: 100, bidLow: 100, bidClose: 100 }
}

function makeWindow(fundingTime: Date, specs: CandleSpec[]): OHLCWindow {
  return new OHLCWindow(specs.map(s => makeRow(fundingTime, s)))
}

const fundingTime = new Date('2025-06-01T00:00:00Z')
const tsAt = (offset: number) => toClickHouseDateTime(new Date(fundingTime.getTime() + offset * 1000))

// Q = max(fundingMult·|F|·100, rangeMult·R_pre)
const params = (over: Partial<DropDetectionParams> = {}): DropDetectionParams => ({
  dropSearchWindowSeconds: 10,
  dropQualifierFundingMult: 0.5,
  dropQualifierRangeMult: 3,
  ...over,
})

describe('detectRealFundingSettlement (§3.1)', () => {
  it('localizes T_drop to the qualifying drop candle', () => {
    // R_pre = 0.2%, |F|=0.01 → Q = max(0.5·1, 3·0.2) = 0.6%
    const window = makeWindow(fundingTime, [
      ...preRows(0.2),
      flat(0),
      flat(1),
      flat(2),
      { offset: 3, bidOpen: 100, bidHigh: 100.1, bidLow: 98, bidClose: 98.5 }, // drop_move 2% ← winner
    ])
    const result = detectRealFundingSettlement(window, fundingTime, -0.01, params())
    expect(result.detected).toBe(true)
    expect(result.noDropLocalized).toBe(false)
    expect(result.settlementTs).toBe(tsAt(3))
  })

  it('falls back to the latest edge with noDropLocalized when nothing qualifies', () => {
    const window = makeWindow(fundingTime, [...preRows(0.2), flat(0), flat(1), flat(2)])
    const result = detectRealFundingSettlement(window, fundingTime, -0.01, params())
    expect(result.detected).toBe(false)
    expect(result.noDropLocalized).toBe(true)
    // latest edge = T_settle + dropSearchWindowSeconds (10s), NOT T_settle
    expect(result.settlementTs).toBe(tsAt(10))
  })

  it('Q gated by |F|: same drop qualifies under small |F|, blocked under large |F|', () => {
    // R_pre ≈ 0 so the funding term dominates. offset-0 drop_move = 1.0%.
    const window = makeWindow(fundingTime, [
      ...preRows(0),
      { offset: 0, bidOpen: 100, bidHigh: 100, bidLow: 99, bidClose: 99.5 }, // drop_move 1%
    ])

    // small |F|=0.01 → Q = 0.5·1 = 0.5 < 1.0 → qualifies
    const ok = detectRealFundingSettlement(window, fundingTime, -0.01, params())
    expect(ok.detected).toBe(true)
    expect(ok.settlementTs).toBe(tsAt(0))

    // large |F|=0.03 → Q = 0.5·3 = 1.5 > 1.0 → blocked
    const blocked = detectRealFundingSettlement(window, fundingTime, -0.03, params())
    expect(blocked.detected).toBe(false)
    expect(blocked.noDropLocalized).toBe(true)
  })

  it('Q gated by R_pre: same drop qualifies under low R_pre, blocked under high R_pre', () => {
    const drop: CandleSpec = { offset: 0, bidOpen: 100, bidHigh: 100, bidLow: 99, bidClose: 99.5 } // drop 1%

    // low R_pre=0.1% → Q = max(0.5·0, 3·0.1) = 0.3 < 1.0 → qualifies (F=0)
    const okWin = makeWindow(fundingTime, [...preRows(0.1), drop])
    const ok = detectRealFundingSettlement(okWin, fundingTime, 0, params())
    expect(ok.detected).toBe(true)
    expect(ok.settlementTs).toBe(tsAt(0))

    // high R_pre=0.5% → Q = 3·0.5 = 1.5 > 1.0 → blocked
    const blockedWin = makeWindow(fundingTime, [...preRows(0.5), drop])
    const blocked = detectRealFundingSettlement(blockedWin, fundingTime, 0, params())
    expect(blocked.detected).toBe(false)
  })

  it('tie-break: equal drop_move → larger red_range wins over the earlier candle', () => {
    // Both candles drop_move = 1% (bid_low 99, prev_close 100).
    // offset 0: not red (close ≥ open) → red_range 0.
    // offset 2: red (close < open), wide range → red_range 1.5% → wins despite being later.
    const window = makeWindow(fundingTime, [
      ...preRows(0),
      { offset: 0, bidOpen: 100, bidHigh: 100, bidLow: 99, bidClose: 100 }, // red_range 0
      flat(1),
      { offset: 2, bidOpen: 100, bidHigh: 100.5, bidLow: 99, bidClose: 99.5 }, // red_range 1.5%
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 0, params())
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(tsAt(2))
  })

  it('tie-break: equal drop_move and equal red_range → earlier candle wins', () => {
    const window = makeWindow(fundingTime, [
      ...preRows(0),
      { offset: 0, bidOpen: 100, bidHigh: 100.5, bidLow: 99, bidClose: 99.5 }, // drop 1%, red_range 1.5%
      flat(1),
      { offset: 2, bidOpen: 100, bidHigh: 100.5, bidLow: 99, bidClose: 99.5 }, // drop 1%, red_range 1.5%
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 0, params())
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(tsAt(0)) // earlier wins
  })

  it('respects the search window edge — a bigger drop outside W is not selected', () => {
    const window = makeWindow(fundingTime, [
      ...preRows(0),
      { offset: 0, bidOpen: 100, bidHigh: 100, bidLow: 99, bidClose: 99.5 }, // drop 1%, inside 5s window
      flat(1),
      flat(2),
      flat(3),
      flat(4),
      flat(5),
      { offset: 6, bidOpen: 100, bidHigh: 100, bidLow: 90, bidClose: 95 }, // drop 10%, outside 5s window
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 0, params({ dropSearchWindowSeconds: 5 }))
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(tsAt(0))
  })

  it('skips candles whose previous 1s close is missing', () => {
    // offset-0 candle has no prev (offset -1 absent) → drop_move uncomputable, skipped.
    // offset-3 candle has its prev (offset 2) → qualifies.
    const window = makeWindow(fundingTime, [
      { offset: -2, ...{ bidOpen: 100, bidHigh: 100, bidLow: 100, bidClose: 100 } },
      { offset: 0, bidOpen: 100, bidHigh: 100, bidLow: 90, bidClose: 95 }, // prev(-1) missing → skipped
      { offset: 2, bidOpen: 100, bidHigh: 100, bidLow: 100, bidClose: 100 },
      { offset: 3, bidOpen: 100, bidHigh: 100, bidLow: 99, bidClose: 99.5 }, // prev(2) present, drop 1%
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 0, params())
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(tsAt(3))
  })
})
