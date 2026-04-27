import { beforeEach, describe, expect, it, vi } from 'vitest'

import { validateCrossExchangeConsistencyFromDescriptors } from '../validation/cross-exchange.js'

const readOrderbookDataMock = vi.hoisted(() => vi.fn())

vi.mock('../validation/reader.js', () => ({
  readOrderbookData: readOrderbookDataMock,
}))

async function* asAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve()
    yield item
  }
}

function getFirst<T>(items: T[]): T {
  const first = items[0]
  if (first === undefined) {
    throw new Error('expected at least one item')
  }
  return first
}

describe('validateCrossExchangeConsistencyFromDescriptors', () => {
  beforeEach(() => {
    readOrderbookDataMock.mockReset()
  })

  it('computes divergence for overlapping timestamps across exchanges', async () => {
    readOrderbookDataMock.mockImplementation((exchange: string) => {
      if (exchange === 'binance') {
        return asAsyncIterable([
          {
            ts: 1_000,
            exchange,
            symbol: 'BTCUSDT',
            bid_close: 99,
            ask_close: 101,
          },
          {
            ts: 2_000,
            exchange,
            symbol: 'BTCUSDT',
            bid_close: 109,
            ask_close: 111,
          },
        ])
      }

      return asAsyncIterable([
        {
          ts: 1_000,
          exchange,
          symbol: 'BTCUSDT',
          bid_close: 100,
          ask_close: 102,
        },
        {
          ts: 2_000,
          exchange,
          symbol: 'BTCUSDT',
          bid_close: 111,
          ask_close: 113,
        },
      ])
    })

    const result = await validateCrossExchangeConsistencyFromDescriptors(
      new Map([
        [
          'BTCUSDT',
          [
            { exchange: 'binance', symbol: 'BTCUSDT' },
            { exchange: 'okx', symbol: 'BTCUSDT' },
          ],
        ],
      ])
    )

    expect(result).toHaveLength(1)
    const first = getFirst(result)
    expect(first).toMatchObject({
      symbol: 'BTCUSDT',
      exchanges: ['binance', 'okx'],
      overlappingSeconds: 2,
      divergenceAboveOnePercentCount: 1,
    })
    expect(first.maxDivergencePercent).toBeCloseTo(1.8018018018018018, 10)
    expect(first.meanDivergencePercent).toBeCloseTo(1.3984133387118463, 10)
  })

  it('returns zero-overlap results when exchanges have valid but non-overlapping data', async () => {
    readOrderbookDataMock.mockImplementation((exchange: string) =>
      asAsyncIterable([
        {
          ts: exchange === 'binance' ? 1_000 : 2_000,
          exchange,
          symbol: 'ETHUSDT',
          bid_close: 199,
          ask_close: 201,
        },
      ])
    )

    const result = await validateCrossExchangeConsistencyFromDescriptors(
      new Map([
        [
          'ETHUSDT',
          [
            { exchange: 'okx', symbol: 'ETHUSDT' },
            { exchange: 'binance', symbol: 'ETHUSDT' },
          ],
        ],
      ])
    )

    expect(result).toEqual([
      {
        symbol: 'ETHUSDT',
        exchanges: ['binance', 'okx'],
        overlappingSeconds: 0,
        meanDivergencePercent: 0,
        maxDivergencePercent: 0,
        divergenceAboveOnePercentCount: 0,
        examples: [],
      },
    ])
  })

  it('skips invalid rows and only uses finite bid/ask pairs', async () => {
    readOrderbookDataMock.mockImplementation((exchange: string) => {
      if (exchange === 'binance') {
        return asAsyncIterable([
          {
            ts: 1_000,
            exchange,
            symbol: 'SOLUSDT',
            bid_close: null,
            ask_close: 101,
          },
          {
            ts: 2_000,
            exchange,
            symbol: 'SOLUSDT',
            bid_close: Number.NaN,
            ask_close: 101,
          },
          {
            ts: 3_000,
            exchange,
            symbol: 'SOLUSDT',
            bid_close: 99,
            ask_close: 101,
          },
        ])
      }

      return asAsyncIterable([
        {
          ts: 3_000,
          exchange,
          symbol: 'SOLUSDT',
          bid_close: 100,
          ask_close: Number.POSITIVE_INFINITY,
        },
        {
          ts: 3_000,
          exchange,
          symbol: 'SOLUSDT',
          bid_close: 101,
          ask_close: 103,
        },
      ])
    })

    const result = await validateCrossExchangeConsistencyFromDescriptors(
      new Map([
        [
          'SOLUSDT',
          [
            { exchange: 'binance', symbol: 'SOLUSDT' },
            { exchange: 'bybit', symbol: 'SOLUSDT' },
          ],
        ],
      ])
    )

    expect(result).toHaveLength(1)
    const first = getFirst(result)
    expect(first).toMatchObject({
      symbol: 'SOLUSDT',
      exchanges: ['binance', 'bybit'],
      overlappingSeconds: 1,
      divergenceAboveOnePercentCount: 1,
    })
    expect(first.meanDivergencePercent).toBeCloseTo(1.9801980198019802, 10)
    expect(first.maxDivergencePercent).toBeCloseTo(1.9801980198019802, 10)
    expect(first.examples).toHaveLength(1)
    const example = getFirst(first.examples)
    expect(example).toMatchObject({
      ts: 3_000,
      lowExchange: 'binance',
      highExchange: 'bybit',
      lowMidPrice: 100,
      highMidPrice: 102,
    })
    expect(example.divergencePercent).toBeCloseTo(1.9801980198019802, 10)
  })

  it('caps divergence examples at ten entries', async () => {
    readOrderbookDataMock.mockImplementation((exchange: string) =>
      asAsyncIterable(
        Array.from({ length: 12 }, (_, index) => ({
          ts: (index + 1) * 1_000,
          exchange,
          symbol: 'XRPUSDT',
          bid_close: exchange === 'binance' ? 99 : 101,
          ask_close: exchange === 'binance' ? 101 : 103,
        }))
      )
    )

    const result = await validateCrossExchangeConsistencyFromDescriptors(
      new Map([
        [
          'XRPUSDT',
          [
            { exchange: 'binance', symbol: 'XRPUSDT' },
            { exchange: 'okx', symbol: 'XRPUSDT' },
          ],
        ],
      ])
    )

    expect(result[0]?.divergenceAboveOnePercentCount).toBe(12)
    expect(result[0]?.examples).toHaveLength(10)
    expect(result[0]?.examples[0]?.ts).toBe(1_000)
    expect(result[0]?.examples[9]?.ts).toBe(10_000)
  })

  it('uses the lowest and highest exchange prices when three exchanges overlap', async () => {
    readOrderbookDataMock.mockImplementation((exchange: string) =>
      asAsyncIterable([
        {
          ts: 1_000,
          exchange,
          symbol: 'ADAUSDT',
          bid_close: exchange === 'binance' ? 98 : exchange === 'bybit' ? 100 : 104,
          ask_close: exchange === 'binance' ? 100 : exchange === 'bybit' ? 102 : 106,
        },
      ])
    )

    const result = await validateCrossExchangeConsistencyFromDescriptors(
      new Map([
        [
          'ADAUSDT',
          [
            { exchange: 'bybit', symbol: 'ADAUSDT' },
            { exchange: 'okx', symbol: 'ADAUSDT' },
            { exchange: 'binance', symbol: 'ADAUSDT' },
          ],
        ],
      ])
    )

    expect(result).toHaveLength(1)
    const first = getFirst(result)
    expect(first).toMatchObject({
      symbol: 'ADAUSDT',
      exchanges: ['binance', 'bybit', 'okx'],
      overlappingSeconds: 1,
      divergenceAboveOnePercentCount: 1,
    })
    expect(first.meanDivergencePercent).toBeCloseTo(5.88235294117647, 10)
    expect(first.maxDivergencePercent).toBeCloseTo(5.88235294117647, 10)
    expect(first.examples).toHaveLength(1)
    const example = getFirst(first.examples)
    expect(example).toMatchObject({
      ts: 1_000,
      lowExchange: 'binance',
      highExchange: 'okx',
      lowMidPrice: 99,
      highMidPrice: 105,
    })
    expect(example.divergencePercent).toBeCloseTo(5.88235294117647, 10)
  })

  it('streams large generated inputs without materializing point arrays', async () => {
    const rowCount = 5_000

    readOrderbookDataMock.mockImplementation(async function* (exchange: string) {
      for (let index = 0; index < rowCount; index += 1) {
        await Promise.resolve()
        yield {
          ts: index * 1_000,
          exchange,
          symbol: 'DOGEUSDT',
          bid_close: exchange === 'binance' ? 99 : 100,
          ask_close: exchange === 'binance' ? 101 : 102,
        }
      }
    })

    const result = await validateCrossExchangeConsistencyFromDescriptors(
      new Map([
        [
          'DOGEUSDT',
          [
            { exchange: 'binance', symbol: 'DOGEUSDT' },
            { exchange: 'okx', symbol: 'DOGEUSDT' },
          ],
        ],
      ])
    )

    expect(result).toHaveLength(1)
    const first = getFirst(result)
    expect(first).toEqual({
      symbol: 'DOGEUSDT',
      exchanges: ['binance', 'okx'],
      overlappingSeconds: rowCount,
      meanDivergencePercent: first.meanDivergencePercent,
      maxDivergencePercent: first.maxDivergencePercent,
      divergenceAboveOnePercentCount: 0,
      examples: [],
    })
    expect(first.meanDivergencePercent).toBeCloseTo(0.9950248756218906, 10)
    expect(first.maxDivergencePercent).toBeCloseTo(0.9950248756218906, 10)
  })
})
