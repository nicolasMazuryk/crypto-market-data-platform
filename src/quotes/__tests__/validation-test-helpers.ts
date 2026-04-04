import type { QuoteRow } from '../validation/types.js'

export function createQuoteRow(ts: number, overrides: Partial<QuoteRow> = {}): QuoteRow {
  return {
    ts,
    exchange: 'okx',
    symbol: 'APTUSDT',
    bid_open: 100,
    bid_high: 100,
    bid_low: 100,
    bid_close: 100,
    ask_open: 101,
    ask_high: 101,
    ask_low: 101,
    ask_close: 101,
    source_type: 'orderbook',
    is_interpolated: false,
    confidence_score: 'high',
    missing_reason: null,
    ...overrides,
  }
}
