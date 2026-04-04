import { describe, expect, it } from 'vitest'

import { buildPerDayBreakdown } from '../validation/per-day-breakdown.js'
import { createQuoteRow } from './validation-test-helpers.js'

describe('buildPerDayBreakdown', () => {
  it('marks full-day boundaries and uses 86,400 expected candles', () => {
    const rows = [
      createQuoteRow(Date.parse('2026-02-03T00:00:00.000Z')),
      createQuoteRow(Date.parse('2026-02-03T23:59:59.000Z')),
    ]

    const result = buildPerDayBreakdown(rows)
    const day = result.days[0]

    expect(day).toBeDefined()
    expect(day?.partialDay).toBe(false)
    expect(day?.expectedCandles).toBe(86_400)
  })

  it('detects partial first/last days and adjusts expected candles to span', () => {
    const start = Date.parse('2026-02-03T12:00:00.000Z')
    const rows = [createQuoteRow(start), createQuoteRow(start + 1_000), createQuoteRow(start + 2_000)]

    const result = buildPerDayBreakdown(rows)
    const day = result.days[0]

    expect(day).toBeDefined()
    expect(day?.partialDay).toBe(true)
    expect(day?.expectedCandles).toBe(3)
    expect(day?.coveragePercent).toBe(100)
  })

  it('flags bad middle days with low coverage', () => {
    const rows = [
      createQuoteRow(Date.parse('2026-02-03T12:00:00.000Z')),
      createQuoteRow(Date.parse('2026-02-03T12:00:01.000Z')),

      createQuoteRow(Date.parse('2026-02-04T01:00:00.000Z'), { is_interpolated: true }),
      createQuoteRow(Date.parse('2026-02-04T01:00:01.000Z'), { is_interpolated: true }),
      createQuoteRow(Date.parse('2026-02-04T01:00:02.000Z'), { is_interpolated: true }),

      createQuoteRow(Date.parse('2026-02-05T12:00:00.000Z')),
      createQuoteRow(Date.parse('2026-02-05T12:00:01.000Z')),
    ]

    const result = buildPerDayBreakdown(rows)

    expect(result.badDayCount).toBe(1)
    expect(result.badDays).toEqual(['2026-02-04'])
    expect(result.bestDay).not.toBeNull()
    expect(result.worstDay).not.toBeNull()
  })
})
