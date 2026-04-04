import type { QuoteRow, SpreadDistributionResult } from './types.js'

const MAJOR_BASE_ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'] as const

function isMajorPair(symbol: string): boolean {
  const normalized = symbol.toUpperCase()
  return MAJOR_BASE_ASSETS.some(asset => normalized.startsWith(asset))
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) {
    return null
  }

  if (sorted.length === 1) {
    return sorted[0] ?? null
  }

  const clampedRatio = Math.min(Math.max(ratio, 0), 1)
  const index = (sorted.length - 1) * clampedRatio
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]

  if (lower === undefined || upper === undefined) {
    return null
  }

  if (lowerIndex === upperIndex) {
    return lower
  }

  const weight = index - lowerIndex
  return lower + (upper - lower) * weight
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

function stddev(values: number[], meanValue: number | null): number | null {
  if (values.length === 0 || meanValue === null) {
    return null
  }

  const variance = values.reduce((sum, value) => sum + (value - meanValue) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function deriveStatus(unreasonablePercent: number): SpreadDistributionResult['status'] {
  if (unreasonablePercent > 5) {
    return 'fail'
  }

  if (unreasonablePercent > 1) {
    return 'warn'
  }

  return 'pass'
}

export class SpreadDistributionAccumulator {
  private readonly thresholdBps: number
  private readonly spreadsBps: number[] = []
  private unreasonableCount = 0

  constructor(symbol: string) {
    this.thresholdBps = isMajorPair(symbol) ? 100 : 500
  }

  update(row: QuoteRow): void {
    if (row.is_interpolated || row.bid_close === null || row.ask_close === null) {
      return
    }

    if (!Number.isFinite(row.bid_close) || !Number.isFinite(row.ask_close)) {
      return
    }

    const midPrice = (row.bid_close + row.ask_close) / 2
    if (midPrice <= 0) {
      return
    }

    const spreadBps = ((row.ask_close - row.bid_close) / midPrice) * 10_000
    this.spreadsBps.push(spreadBps)

    if (spreadBps > this.thresholdBps) {
      this.unreasonableCount += 1
    }
  }

  finalize(): SpreadDistributionResult {
    this.spreadsBps.sort((left, right) => left - right)
    const meanBps = mean(this.spreadsBps)
    const unreasonablePercent =
      this.spreadsBps.length === 0 ? 0 : (this.unreasonableCount / this.spreadsBps.length) * 100

    return {
      sampleCount: this.spreadsBps.length,
      thresholdBps: this.thresholdBps,
      meanBps,
      medianBps: percentile(this.spreadsBps, 0.5),
      p75Bps: percentile(this.spreadsBps, 0.75),
      p95Bps: percentile(this.spreadsBps, 0.95),
      p99Bps: percentile(this.spreadsBps, 0.99),
      stddevBps: stddev(this.spreadsBps, meanBps),
      unreasonableCount: this.unreasonableCount,
      unreasonablePercent,
      status: deriveStatus(unreasonablePercent),
    }
  }
}

export function analyzeSpreadDistribution(rows: QuoteRow[], symbol: string): SpreadDistributionResult {
  const accumulator = new SpreadDistributionAccumulator(symbol)

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
