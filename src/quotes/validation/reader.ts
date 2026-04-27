import type { OrderbookRow } from '../../db/types.js'
import { streamOrderbookLiteRows, streamOrderbookRows } from '../../db/queries/orderbooks.js'
import type { OrderbookLiteRow } from '../../db/queries/orderbooks.js'
import type { QuoteRow } from './types.js'

function asTimestampMs(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  if (typeof value === 'string') {
    const numeric = Number(value)
    if (!Number.isNaN(numeric)) {
      return numeric
    }

    const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return 0
}

function toQuoteRow(row: OrderbookRow): QuoteRow {
  return {
    ts: asTimestampMs(row.ts),
    exchange: row.exchange,
    symbol: row.symbol,
    bid_open: row.bid_open,
    bid_high: row.bid_high,
    bid_low: row.bid_low,
    bid_close: row.bid_close,
    ask_open: row.ask_open,
    ask_high: row.ask_high,
    ask_low: row.ask_low,
    ask_close: row.ask_close,
    source_type: row.source_type,
    is_interpolated: row.is_interpolated,
    confidence_score: row.confidence_score,
    missing_reason: row.missing_reason,
  }
}

export async function* readOrderbookData(
  exchange: string,
  symbol: string,
  startTime?: string,
  endTime?: string
): AsyncIterable<QuoteRow> {
  for await (const row of streamOrderbookRows(exchange, symbol, startTime, endTime)) {
    yield toQuoteRow(row)
  }
}

function liteToQuoteRow(row: OrderbookLiteRow): QuoteRow {
  return {
    ts: asTimestampMs(row.ts),
    exchange: '',
    symbol: '',
    bid_open: null,
    bid_high: null,
    bid_low: null,
    bid_close: row.bid_close,
    ask_open: null,
    ask_high: null,
    ask_low: null,
    ask_close: row.ask_close,
    source_type: '',
    is_interpolated: row.is_interpolated,
    confidence_score: '',
    missing_reason: null,
  }
}

export async function* readOrderbookLiteData(exchange: string, symbol: string): AsyncIterable<QuoteRow> {
  for await (const row of streamOrderbookLiteRows(exchange, symbol)) {
    yield liteToQuoteRow(row)
  }
}
