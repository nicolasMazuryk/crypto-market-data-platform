import { insertOrderbooks } from '../../db/queries/orderbooks.js'
import { toClickHouseDateTime, type OrderbookRow } from '../../db/types.js'
import type { QuoteCandle1s } from '../types.js'

const INSERT_BATCH_SIZE = 10_000

function toOrderbookRow(candle: QuoteCandle1s): OrderbookRow {
  return {
    exchange: candle.exchange,
    symbol: candle.symbol,
    ts: toClickHouseDateTime(new Date(candle.ts * 1000)),
    bid_open: candle.bidOpen,
    bid_high: candle.bidHigh,
    bid_low: candle.bidLow,
    bid_close: candle.bidClose,
    ask_open: candle.askOpen,
    ask_high: candle.askHigh,
    ask_low: candle.askLow,
    ask_close: candle.askClose,
    source_type: candle.sourceType,
    is_interpolated: candle.isInterpolated,
    confidence_score: candle.confidenceScore,
    missing_reason: candle.missingReason,
  }
}

export async function writeQuoteCandlesToClickHouse(candles: AsyncIterable<QuoteCandle1s>): Promise<number> {
  const batch: OrderbookRow[] = []
  let totalRows = 0

  for await (const candle of candles) {
    batch.push(toOrderbookRow(candle))

    if (batch.length < INSERT_BATCH_SIZE) {
      continue
    }

    await insertOrderbooks(batch)
    totalRows += batch.length
    batch.length = 0
  }

  if (batch.length > 0) {
    await insertOrderbooks(batch)
    totalRows += batch.length
  }

  return totalRows
}
