import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QuoteCandle1s } from '../types.js'

const insertOrderbooksMock = vi.hoisted(() => vi.fn<(rows: unknown[]) => Promise<void>>())

vi.mock('../../db/queries/orderbooks.js', () => ({
  insertOrderbooks: insertOrderbooksMock,
}))

import { writeQuoteCandlesToClickHouse } from '../writer/clickhouse-writer.js'

async function* asAsyncIterable(candles: QuoteCandle1s[]): AsyncIterable<QuoteCandle1s> {
  for (const candle of candles) {
    await Promise.resolve()
    yield candle
  }
}

describe('writeQuoteCandlesToClickHouse', () => {
  beforeEach(() => {
    insertOrderbooksMock.mockReset()
    insertOrderbooksMock.mockResolvedValue(undefined)
  })

  it('converts candles and inserts all rows', async () => {
    const candles: QuoteCandle1s[] = [
      {
        ts: 1,
        exchange: 'binance',
        symbol: 'BTCUSDT',
        bidOpen: 10,
        bidHigh: 11,
        bidLow: 9,
        bidClose: 10.5,
        askOpen: 10.8,
        askHigh: 11.2,
        askLow: 10.7,
        askClose: 11,
        sourceType: 'orderbook',
        isInterpolated: false,
        confidenceScore: 'high',
        missingReason: null,
      },
      {
        ts: 2,
        exchange: 'binance',
        symbol: 'BTCUSDT',
        bidOpen: null,
        bidHigh: null,
        bidLow: null,
        bidClose: null,
        askOpen: 11,
        askHigh: 12,
        askLow: 10,
        askClose: 11.5,
        sourceType: 'trades',
        isInterpolated: true,
        confidenceScore: 'low',
        missingReason: 'no_prior_state',
      },
    ]

    const rowsWritten = await writeQuoteCandlesToClickHouse(asAsyncIterable(candles))

    expect(rowsWritten).toBe(2)
    expect(insertOrderbooksMock).toHaveBeenCalledTimes(1)
    expect(insertOrderbooksMock).toHaveBeenCalledWith([
      expect.objectContaining({
        ts: '1970-01-01 00:00:01',
        exchange: 'binance',
        symbol: 'BTCUSDT',
        source_type: 'orderbook',
        is_interpolated: false,
        confidence_score: 'high',
      }),
      expect.objectContaining({
        ts: '1970-01-01 00:00:02',
        source_type: 'trades',
        is_interpolated: true,
        confidence_score: 'low',
        missing_reason: 'no_prior_state',
      }),
    ])
  })

  it('returns zero and performs no inserts for empty streams', async () => {
    const rowsWritten = await writeQuoteCandlesToClickHouse(asAsyncIterable([]))

    expect(rowsWritten).toBe(0)
    expect(insertOrderbooksMock).not.toHaveBeenCalled()
  })
})
