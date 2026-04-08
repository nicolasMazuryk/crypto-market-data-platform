import { describe, it, expect } from 'vitest'
import type { OrderbookRow } from '../../db/types.js'
import { checkLimitFill } from '../orders/limit-order.js'

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

describe('Limit Order', () => {
  it('BUY LIMIT fills when ask_low < limit_price', () => {
    // ask_low = 49960, limit at 49970 → should fill
    const fill = checkLimitFill('buy', 49970, makeCandle(), 1, 'entry')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBe(49970) // Fills at limit price
    expect(fill.feeType).toBe('maker')
  })

  it('BUY LIMIT does NOT fill when ask_low >= limit_price', () => {
    // ask_low = 49960, limit at 49950 → no fill
    const fill = checkLimitFill('buy', 49950, makeCandle(), 1, 'entry')
    expect(fill).toBeNull()
  })

  it('SELL LIMIT fills when bid_high > limit_price', () => {
    // bid_high = 50050, limit at 50040 → should fill
    const fill = checkLimitFill('sell', 50040, makeCandle(), 1, 'tp')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBe(50040)
    expect(fill.feeType).toBe('maker')
  })

  it('SELL LIMIT does NOT fill when bid_high <= limit_price', () => {
    // bid_high = 50050, limit at 50060 → no fill
    const fill = checkLimitFill('sell', 50060, makeCandle(), 1, 'tp')
    expect(fill).toBeNull()
  })

  it('returns null for null ask_low on BUY', () => {
    const fill = checkLimitFill('buy', 49970, makeCandle({ ask_low: null }), 1, 'entry')
    expect(fill).toBeNull()
  })

  it('returns null for null bid_high on SELL', () => {
    const fill = checkLimitFill('sell', 50040, makeCandle({ bid_high: null }), 1, 'tp')
    expect(fill).toBeNull()
  })
})
