import { readOrderbookData } from './reader.js'
import type { CrossExchangeResult, CrossExchangeSeriesInput, QuoteDataDescriptor, QuoteRow } from './types.js'

const EXAMPLE_LIMIT = 10

interface StreamPoint {
  readonly ts: number
  readonly midPrice: number
}

interface ExchangeCursor {
  readonly exchange: string
  readonly iterator: AsyncIterator<QuoteRow>
  current: StreamPoint | null
}

function divergencePercent(low: number, high: number): number {
  const midpoint = (low + high) / 2
  if (midpoint === 0) {
    return 0
  }

  return ((high - low) / midpoint) * 100
}

export function validateCrossExchangeConsistency(
  seriesBySymbol: Map<string, CrossExchangeSeriesInput[]>
): CrossExchangeResult[] {
  const results: CrossExchangeResult[] = []

  for (const [symbol, seriesList] of seriesBySymbol.entries()) {
    if (seriesList.length < 2) {
      continue
    }

    const byTimestamp = new Map<number, Map<string, number>>()
    for (const series of seriesList) {
      for (const point of series.points) {
        const existing = byTimestamp.get(point.ts)
        if (existing) {
          existing.set(series.exchange, point.midPrice)
        } else {
          byTimestamp.set(point.ts, new Map([[series.exchange, point.midPrice]]))
        }
      }
    }

    let overlappingSeconds = 0
    let divergenceSum = 0
    let maxDivergencePercent = 0
    let divergenceAboveOnePercentCount = 0
    const examples: CrossExchangeResult['examples'] = []

    const sortedTimestamps = [...byTimestamp.keys()].sort((left, right) => left - right)
    for (const ts of sortedTimestamps) {
      const pricesByExchange = byTimestamp.get(ts)
      if (!pricesByExchange || pricesByExchange.size < 2) {
        continue
      }

      let lowExchange = ''
      let highExchange = ''
      let lowMidPrice = Number.POSITIVE_INFINITY
      let highMidPrice = Number.NEGATIVE_INFINITY

      for (const [exchange, midPrice] of pricesByExchange.entries()) {
        if (midPrice < lowMidPrice) {
          lowMidPrice = midPrice
          lowExchange = exchange
        }

        if (midPrice > highMidPrice) {
          highMidPrice = midPrice
          highExchange = exchange
        }
      }

      const currentDivergencePercent = divergencePercent(lowMidPrice, highMidPrice)
      overlappingSeconds += 1
      divergenceSum += currentDivergencePercent
      maxDivergencePercent = Math.max(maxDivergencePercent, currentDivergencePercent)

      if (currentDivergencePercent > 1) {
        divergenceAboveOnePercentCount += 1
        if (examples.length < EXAMPLE_LIMIT) {
          examples.push({
            ts,
            divergencePercent: currentDivergencePercent,
            lowExchange,
            highExchange,
            lowMidPrice,
            highMidPrice,
          })
        }
      }
    }

    const exchanges = [...new Set(seriesList.map(series => series.exchange))].sort((left, right) =>
      left.localeCompare(right)
    )

    results.push({
      symbol,
      exchanges,
      overlappingSeconds,
      meanDivergencePercent: overlappingSeconds === 0 ? 0 : divergenceSum / overlappingSeconds,
      maxDivergencePercent,
      divergenceAboveOnePercentCount,
      examples,
    })
  }

  return results.sort((left, right) => left.symbol.localeCompare(right.symbol))
}

function toStreamPoint(row: QuoteRow): StreamPoint | null {
  if (
    row.bid_close === null ||
    row.ask_close === null ||
    !Number.isFinite(row.bid_close) ||
    !Number.isFinite(row.ask_close)
  ) {
    return null
  }

  return {
    ts: row.ts,
    midPrice: (row.bid_close + row.ask_close) / 2,
  }
}

async function advanceToNextValidPoint(iterator: AsyncIterator<QuoteRow>): Promise<StreamPoint | null> {
  for (;;) {
    const result = await iterator.next()
    if (result.done) {
      return null
    }

    const point = toStreamPoint(result.value)
    if (point) {
      return point
    }
  }
}

async function closeCursor(cursor: ExchangeCursor): Promise<void> {
  await cursor.iterator.return?.()
}

function compareExchange(left: string, right: string): number {
  return left.localeCompare(right)
}

export async function validateCrossExchangeConsistencyFromDescriptors(
  descriptorsBySymbol: Map<string, QuoteDataDescriptor[]>
): Promise<CrossExchangeResult[]> {
  const results: CrossExchangeResult[] = []
  const sortedSymbols = [...descriptorsBySymbol.keys()].sort((left, right) => left.localeCompare(right))

  for (const symbol of sortedSymbols) {
    const descriptors = descriptorsBySymbol.get(symbol)
    if (!descriptors || descriptors.length < 2) {
      continue
    }

    const sortedDescriptors = [...descriptors].sort((left, right) => compareExchange(left.exchange, right.exchange))
    const cursors: ExchangeCursor[] = await Promise.all(
      sortedDescriptors.map(async descriptor => {
        const iterator = readOrderbookData(descriptor.exchange, descriptor.symbol)[Symbol.asyncIterator]()
        return {
          exchange: descriptor.exchange,
          iterator,
          current: await advanceToNextValidPoint(iterator),
        }
      })
    )

    try {
      const exchangesWithValidPoints = new Set(
        cursors.filter(cursor => cursor.current !== null).map(cursor => cursor.exchange)
      )

      if (exchangesWithValidPoints.size < 2) {
        continue
      }

      let overlappingSeconds = 0
      let divergenceSum = 0
      let maxDivergencePercent = 0
      let divergenceAboveOnePercentCount = 0
      const examples: CrossExchangeResult['examples'] = []

      for (;;) {
        const activeCursors = cursors.filter(cursor => cursor.current !== null)
        if (activeCursors.length < 2) {
          break
        }

        const minTimestamp = Math.min(...activeCursors.map(cursor => cursor.current?.ts ?? Number.POSITIVE_INFINITY))
        const matchingCursors = activeCursors.filter(cursor => cursor.current?.ts === minTimestamp)

        if (matchingCursors.length >= 2) {
          let lowExchange = ''
          let highExchange = ''
          let lowMidPrice = Number.POSITIVE_INFINITY
          let highMidPrice = Number.NEGATIVE_INFINITY

          for (const cursor of matchingCursors) {
            const current = cursor.current
            if (!current) {
              continue
            }

            if (
              current.midPrice < lowMidPrice ||
              (current.midPrice === lowMidPrice && compareExchange(cursor.exchange, lowExchange) < 0)
            ) {
              lowMidPrice = current.midPrice
              lowExchange = cursor.exchange
            }

            if (
              current.midPrice > highMidPrice ||
              (current.midPrice === highMidPrice && compareExchange(cursor.exchange, highExchange) < 0)
            ) {
              highMidPrice = current.midPrice
              highExchange = cursor.exchange
            }
          }

          const currentDivergencePercent = divergencePercent(lowMidPrice, highMidPrice)
          overlappingSeconds += 1
          divergenceSum += currentDivergencePercent
          maxDivergencePercent = Math.max(maxDivergencePercent, currentDivergencePercent)

          if (currentDivergencePercent > 1) {
            divergenceAboveOnePercentCount += 1
            if (examples.length < EXAMPLE_LIMIT) {
              examples.push({
                ts: minTimestamp,
                divergencePercent: currentDivergencePercent,
                lowExchange,
                highExchange,
                lowMidPrice,
                highMidPrice,
              })
            }
          }
        }

        await Promise.all(
          matchingCursors.map(async cursor => {
            cursor.current = await advanceToNextValidPoint(cursor.iterator)
          })
        )
      }

      results.push({
        symbol,
        exchanges: [...exchangesWithValidPoints].sort(compareExchange),
        overlappingSeconds,
        meanDivergencePercent: overlappingSeconds === 0 ? 0 : divergenceSum / overlappingSeconds,
        maxDivergencePercent,
        divergenceAboveOnePercentCount,
        examples,
      })
    } finally {
      await Promise.all(cursors.map(closeCursor))
    }
  }

  return results
}
