import { describe, it, expect } from 'vitest'
import type { OrderbookRow } from '../../db/types.js'
import { checkStopFill } from '../orders/stop-order.js'

function makeCandle(overrides: Partial<OrderbookRow> = {}): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts: '2025-06-01 00:00:00',
    bid_open: 50000,
    bid_high: 50050,
    bid_low: 49950,
    bid_close: 50000,
    ask_open: 50010,
    ask_high: 50060,
    ask_low: 49960,
    ask_close: 50010,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
    ...overrides,
  }
}

describe('Stop Order', () => {
  it('BUY STOP triggers when ask_high >= stop_price', () => {
    // ask_high = 50060, stop at 50050 → triggers
    const fill = checkStopFill('buy', 50050, makeCandle(), 1, 0.0001, 'sl')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBeCloseTo(50050 * 1.0001, 2) // stop + slippage
    expect(fill.feeType).toBe('taker')
  })

  it('BUY STOP does NOT trigger when ask_high < stop_price', () => {
    const fill = checkStopFill('buy', 50070, makeCandle(), 1, 0.0001, 'sl')
    expect(fill).toBeNull()
  })

  it('SELL STOP triggers when bid_low <= stop_price', () => {
    // bid_low = 49950, stop at 49960 → triggers
    const fill = checkStopFill('sell', 49960, makeCandle(), 1, 0.0001, 'sl')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBeCloseTo(49960 * 0.9999, 2) // stop - slippage
    expect(fill.feeType).toBe('taker')
  })

  it('SELL STOP does NOT trigger when bid_low > stop_price', () => {
    const fill = checkStopFill('sell', 49940, makeCandle(), 1, 0.0001, 'sl')
    expect(fill).toBeNull()
  })

  it('returns null for null ask_high on BUY', () => {
    const fill = checkStopFill('buy', 50050, makeCandle({ ask_high: null }), 1, 0.0001, 'sl')
    expect(fill).toBeNull()
  })

  it('returns null for null bid_low on SELL', () => {
    const fill = checkStopFill('sell', 49960, makeCandle({ bid_low: null }), 1, 0.0001, 'sl')
    expect(fill).toBeNull()
  })

  it('BUY STOP gap-through: candle opens past the stop, fills at ask_open not stopPrice', () => {
    // ask_open=50010, stop=50050 doesn't trigger gap path (existing fixture check)
    const noGap = checkStopFill('buy', 50050, makeCandle(), 1, 0.0001, 'sl')
    if (!noGap) throw new Error('expected fill')
    expect(noGap.price).toBeCloseTo(50050 * 1.0001, 2)
    expect(noGap.price).not.toBeCloseTo(50010 * 1.0001, 2)

    // ask_open=50055 >= stop=50050 → gapped through, fill at ask_open
    const gapped = checkStopFill('buy', 50050, makeCandle({ ask_open: 50055, ask_high: 50060 }), 1, 0.0001, 'sl')
    if (!gapped) throw new Error('expected fill')
    expect(gapped.price).toBeCloseTo(50055 * 1.0001, 2)
    expect(gapped.price).not.toBeCloseTo(50050 * 1.0001, 2)
  })

  it('SELL STOP gap-through: candle opens past the stop, fills at bid_open not stopPrice', () => {
    // bid_open=50000 > stop=49960 doesn't gap (existing fixture)
    const noGap = checkStopFill('sell', 49960, makeCandle(), 1, 0.0001, 'sl')
    if (!noGap) throw new Error('expected fill')
    expect(noGap.price).toBeCloseTo(49960 * 0.9999, 2)
    expect(noGap.price).not.toBeCloseTo(50000 * 0.9999, 2)

    // bid_open=49945 <= stop=49960 → gapped through, fill at bid_open
    const gapped = checkStopFill('sell', 49960, makeCandle({ bid_open: 49945, bid_low: 49940 }), 1, 0.0001, 'sl')
    if (!gapped) throw new Error('expected fill')
    expect(gapped.price).toBeCloseTo(49945 * 0.9999, 2)
    expect(gapped.price).not.toBeCloseTo(49960 * 0.9999, 2)
  })

  it('BUY STOP gap-through falls back to trigger-level fill when ask_open is null', () => {
    const fill = checkStopFill('buy', 50050, makeCandle({ ask_open: null, ask_high: 50060 }), 1, 0.0001, 'sl')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBeCloseTo(50050 * 1.0001, 2)
  })

  it('SELL STOP gap-through falls back to trigger-level fill when bid_open is null', () => {
    const fill = checkStopFill('sell', 49960, makeCandle({ bid_open: null, bid_low: 49940 }), 1, 0.0001, 'sl')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBeCloseTo(49960 * 0.9999, 2)
  })
})
