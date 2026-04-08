import type { CrossExchangeResult, CrossExchangeSeriesInput } from './types.js'

const EXAMPLE_LIMIT = 10

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
