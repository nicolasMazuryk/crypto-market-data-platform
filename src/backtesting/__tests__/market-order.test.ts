import { describe, it, expect } from 'vitest'
import type { OrderbookRow } from '../../db/types.js'
import { fillMarketOrder } from '../orders/market-order.js'

function makeCandle(askOpen: number | null, bidOpen: number | null): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts: '2025-06-01 00:00:00',
    bid_open: bidOpen,
    bid_high: bidOpen ? bidOpen * 1.001 : null,
    bid_low: bidOpen ? bidOpen * 0.999 : null,
    bid_close: bidOpen,
    ask_open: askOpen,
    ask_high: askOpen ? askOpen * 1.001 : null,
    ask_low: askOpen ? askOpen * 0.999 : null,
    ask_close: askOpen,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
  }
}

describe('Market Order', () => {
  it('BUY MARKET fills at ask_open', () => {
    const candle = makeCandle(50010, 50000)
    const fill = fillMarketOrder('buy', candle, 1, 'entry')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBe(50010)
    expect(fill.feeType).toBe('taker')
  })

  it('SELL MARKET fills at bid_open', () => {
    const candle = makeCandle(50010, 50000)
    const fill = fillMarketOrder('sell', candle, 1, 'exit')
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBe(50000)
    expect(fill.feeType).toBe('taker')
  })

  it('returns null for null ask_open on BUY', () => {
    const candle = makeCandle(null, 50000)
    const fill = fillMarketOrder('buy', candle, 1, 'entry')
    expect(fill).toBeNull()
  })

  it('returns null for null bid_open on SELL', () => {
    const candle = makeCandle(50010, null)
    const fill = fillMarketOrder('sell', candle, 1, 'exit')
    expect(fill).toBeNull()
  })

  it('BUY MARKET with slippage fills at ask_open * (1 + slippage)', () => {
    const candle = makeCandle(50010, 50000)
    const fill = fillMarketOrder('buy', candle, 1, 'entry', 0.0005)
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBeCloseTo(50010 * 1.0005, 6)
  })

  it('SELL MARKET with slippage fills at bid_open * (1 - slippage)', () => {
    const candle = makeCandle(50010, 50000)
    const fill = fillMarketOrder('sell', candle, 1, 'exit', 0.0005)
    if (!fill) throw new Error('expected fill')
    expect(fill.price).toBeCloseTo(50000 * 0.9995, 6)
  })

  it('null ask_open with slippage still returns null (no NaN)', () => {
    const candle = makeCandle(null, 50000)
    const fill = fillMarketOrder('buy', candle, 1, 'entry', 0.0005)
    expect(fill).toBeNull()
  })
})
