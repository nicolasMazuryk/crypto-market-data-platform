import { describe, expect, it } from 'vitest'

import { analyzeSpreadDistribution } from '../validation/spread-distribution.js'
import { createQuoteRow } from './validation-test-helpers.js'

function createRowsWithSpreadBps(startTs: number, count: number, spreadBps: number) {
  const mid = 100
  const spread = (spreadBps / 10_000) * mid
  const bid = mid - spread / 2
  const ask = mid + spread / 2

  return Array.from({ length: count }, (_value, index) =>
    createQuoteRow(startTs + index * 1_000, {
      bid_close: bid,
      ask_close: ask,
      bid_open: bid,
      bid_high: bid,
      bid_low: bid,
      ask_open: ask,
      ask_high: ask,
      ask_low: ask,
      is_interpolated: false,
    })
  )
}

describe('analyzeSpreadDistribution', () => {
  it('computes stable percentiles for uniform spreads', () => {
    const rows = createRowsWithSpreadBps(Date.parse('2026-02-03T00:00:00.000Z'), 20, 25)

    const result = analyzeSpreadDistribution(rows, 'APTUSDT')

    expect(result.sampleCount).toBe(20)
    expect(result.medianBps).toBeCloseTo(25, 6)
    expect(result.p95Bps).toBeCloseTo(25, 6)
    expect(result.stddevBps).toBeCloseTo(0, 6)
    expect(result.status).toBe('pass')
  })

  it('applies stricter thresholds to major pairs', () => {
    const rows = createRowsWithSpreadBps(Date.parse('2026-02-03T00:00:00.000Z'), 10, 200)

    const major = analyzeSpreadDistribution(rows, 'BTCUSDT')
    const alt = analyzeSpreadDistribution(rows, 'ACEUSDT')

    expect(major.thresholdBps).toBe(100)
    expect(major.unreasonableCount).toBe(10)
    expect(major.status).toBe('fail')

    expect(alt.thresholdBps).toBe(500)
    expect(alt.unreasonableCount).toBe(0)
    expect(alt.status).toBe('pass')
  })
})
