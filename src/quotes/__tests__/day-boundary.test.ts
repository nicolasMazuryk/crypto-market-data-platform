import { describe, expect, it } from 'vitest'

import { validateDayBoundaryContinuity } from '../validation/day-boundary.js'
import { createQuoteRow } from './validation-test-helpers.js'

const DAY_1_END = Date.parse('2026-02-03T23:59:59.000Z')
const DAY_2_START = Date.parse('2026-02-04T00:00:00.000Z')

describe('validateDayBoundaryContinuity', () => {
  it('returns pass for single-day datasets', () => {
    const rows = [createQuoteRow(Date.parse('2026-02-03T12:00:00.000Z'))]

    const result = validateDayBoundaryContinuity(rows)

    expect(result.dayCount).toBe(1)
    expect(result.checkedBoundaryCount).toBe(0)
    expect(result.pass).toBe(true)
  })

  it('passes perfect 1-second boundaries with midnight candle present', () => {
    const rows = [
      createQuoteRow(DAY_1_END, { bid_close: 100, ask_close: 100 }),
      createQuoteRow(DAY_2_START, { bid_close: 100, ask_close: 100 }),
    ]

    const result = validateDayBoundaryContinuity(rows)

    expect(result.checkedBoundaryCount).toBe(1)
    expect(result.gapAtBoundaryCount).toBe(0)
    expect(result.midnightMissingCount).toBe(0)
    expect(result.priceJumpCount).toBe(0)
    expect(result.pass).toBe(true)
  })

  it('detects midnight gaps and missing midnight candles', () => {
    const rows = [
      createQuoteRow(DAY_1_END, { bid_close: 100, ask_close: 100 }),
      createQuoteRow(DAY_2_START + 2_000, { bid_close: 100, ask_close: 100 }),
    ]

    const result = validateDayBoundaryContinuity(rows)

    expect(result.gapAtBoundaryCount).toBe(1)
    expect(result.midnightMissingCount).toBe(1)
    expect(result.examples).toHaveLength(1)
    expect(result.examples[0]?.missingSeconds).toBe(2)
    expect(result.pass).toBe(false)
  })

  it('detects significant price jumps at day boundaries', () => {
    const rows = [
      createQuoteRow(DAY_1_END, { bid_close: 100, ask_close: 100 }),
      createQuoteRow(DAY_2_START, { bid_close: 100.5, ask_close: 100.5 }),
    ]

    const result = validateDayBoundaryContinuity(rows)

    expect(result.gapAtBoundaryCount).toBe(0)
    expect(result.priceJumpCount).toBe(1)
    expect(result.pass).toBe(false)
  })
})
