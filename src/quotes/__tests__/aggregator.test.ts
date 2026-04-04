import { describe, expect, it } from 'vitest'

import { aggregateQuoteEvents } from '../aggregator/ohlc-1s.js'
import type { QuoteAggregationContext, QuoteCandle1s, QuoteEvent } from '../types.js'

async function* asAsyncIterable(events: QuoteEvent[]): AsyncIterable<QuoteEvent> {
  for (const event of events) {
    await Promise.resolve()
    yield event
  }
}

async function collectCandles(events: QuoteEvent[], context: QuoteAggregationContext): Promise<QuoteCandle1s[]> {
  const output: QuoteCandle1s[] = []

  for await (const candle of aggregateQuoteEvents(asAsyncIterable(events), context)) {
    output.push(candle)
  }

  return output
}

describe('aggregateQuoteEvents', () => {
  it('returns no candles for an empty input stream', async () => {
    const context: QuoteAggregationContext = {
      exchange: 'testex',
      symbol: 'EMPTYUSDT',
      sourceType: 'orderbook',
      confidenceScore: 'high',
    }

    const candles = await collectCandles([], context)
    expect(candles).toEqual([])
  })

  it('emits a single candle for a single event', async () => {
    const context: QuoteAggregationContext = {
      exchange: 'testex',
      symbol: 'ONEUSDT',
      sourceType: 'orderbook',
      confidenceScore: 'high',
    }

    const candles = await collectCandles([{ timestampMs: 1_500, bid: 10, ask: 11, sourceType: 'orderbook' }], context)
    expect(candles).toHaveLength(1)
    expect(candles[0]).toMatchObject({
      ts: 1,
      bidOpen: 10,
      bidHigh: 10,
      bidLow: 10,
      bidClose: 10,
      askOpen: 11,
      askHigh: 11,
      askLow: 11,
      askClose: 11,
      isInterpolated: false,
      missingReason: null,
    })
  })

  it('tracks high and low correctly within the same second', async () => {
    const context: QuoteAggregationContext = {
      exchange: 'testex',
      symbol: 'RANGEUSDT',
      sourceType: 'orderbook',
      confidenceScore: 'high',
    }

    const candles = await collectCandles(
      [
        { timestampMs: 2_100, bid: 10, ask: 11, sourceType: 'orderbook' },
        { timestampMs: 2_400, bid: 9, ask: 12, sourceType: 'orderbook' },
        { timestampMs: 2_900, bid: 11, ask: 10.5, sourceType: 'orderbook' },
      ],
      context
    )

    expect(candles).toHaveLength(1)
    expect(candles[0]).toMatchObject({
      ts: 2,
      bidOpen: 10,
      bidHigh: 11,
      bidLow: 9,
      bidClose: 11,
      askOpen: 11,
      askHigh: 12,
      askLow: 10.5,
      askClose: 10.5,
      isInterpolated: false,
    })
  })

  it('aggregates OHLC by second and forward-fills missing seconds', async () => {
    const context: QuoteAggregationContext = {
      exchange: 'testex',
      symbol: 'TESTUSDT',
      sourceType: 'orderbook',
      confidenceScore: 'high',
    }

    const candles = await collectCandles(
      [
        { timestampMs: 1000, bid: 1, ask: 2, sourceType: 'orderbook' },
        { timestampMs: 1300, bid: 1.2, ask: 2.1, sourceType: 'orderbook' },
        { timestampMs: 4000, bid: 1.1, ask: 2.2, sourceType: 'orderbook' },
      ],
      context
    )

    expect(candles).toHaveLength(4)

    expect(candles[0]).toMatchObject({
      ts: 1,
      bidOpen: 1,
      bidHigh: 1.2,
      bidLow: 1,
      bidClose: 1.2,
      askOpen: 2,
      askHigh: 2.1,
      askLow: 2,
      askClose: 2.1,
      isInterpolated: false,
    })

    expect(candles[1]).toMatchObject({
      ts: 2,
      bidOpen: 1.2,
      askOpen: 2.1,
      isInterpolated: true,
    })

    expect(candles[2]).toMatchObject({
      ts: 3,
      bidOpen: 1.2,
      askOpen: 2.1,
      isInterpolated: true,
    })

    expect(candles[3]).toMatchObject({
      ts: 4,
      bidOpen: 1.1,
      askOpen: 2.2,
      isInterpolated: false,
    })
  })

  it('throws when events are out of order', async () => {
    const context: QuoteAggregationContext = {
      exchange: 'testex',
      symbol: 'SORTUSDT',
      sourceType: 'orderbook',
      confidenceScore: 'high',
    }

    await expect(
      collectCandles(
        [
          { timestampMs: 2_000, bid: 1, ask: 2, sourceType: 'orderbook' },
          { timestampMs: 1_000, bid: 1, ask: 2, sourceType: 'orderbook' },
        ],
        context
      )
    ).rejects.toThrow('Input events must be sorted by timestamp')
  })

  it('marks missing reason until both sides are known for trade-only streams', async () => {
    const context: QuoteAggregationContext = {
      exchange: 'binance',
      symbol: 'ACEUSDT',
      sourceType: 'trades',
      confidenceScore: 'low',
    }

    const candles = await collectCandles(
      [
        { timestampMs: 1000, bid: 10, ask: null, sourceType: 'trades' },
        { timestampMs: 3000, bid: null, ask: 12, sourceType: 'trades' },
      ],
      context
    )

    expect(candles).toHaveLength(3)

    expect(candles[0]).toMatchObject({
      ts: 1,
      bidClose: 10,
      askClose: null,
      missingReason: 'no_prior_state',
      isInterpolated: false,
    })

    expect(candles[1]).toMatchObject({
      ts: 2,
      bidClose: 10,
      askClose: null,
      missingReason: 'no_prior_state',
      isInterpolated: true,
    })

    expect(candles[2]).toMatchObject({
      ts: 3,
      bidClose: 10,
      askClose: 12,
      missingReason: null,
      isInterpolated: false,
    })
  })

  it('fills large gaps with interpolated candles', async () => {
    const context: QuoteAggregationContext = {
      exchange: 'testex',
      symbol: 'GAPUSDT',
      sourceType: 'orderbook',
      confidenceScore: 'high',
    }

    const candles = await collectCandles(
      [
        { timestampMs: 1_000, bid: 10, ask: 11, sourceType: 'orderbook' },
        { timestampMs: 101_000, bid: 12, ask: 13, sourceType: 'orderbook' },
      ],
      context
    )

    expect(candles).toHaveLength(101)
    expect(candles[0]?.isInterpolated).toBe(false)
    expect(candles[1]?.isInterpolated).toBe(true)
    expect(candles[99]?.isInterpolated).toBe(true)
    expect(candles[100]).toMatchObject({
      ts: 101,
      bidClose: 12,
      askClose: 13,
      isInterpolated: false,
    })
  })
})
