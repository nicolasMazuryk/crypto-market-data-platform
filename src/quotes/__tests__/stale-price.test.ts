import { describe, expect, it } from 'vitest'

import { detectStalePrice } from '../validation/stale-price.js'
import { createQuoteRow } from './validation-test-helpers.js'

function buildFlatRows(startTs: number, seconds: number, bidClose = 100, askClose = 101) {
  return Array.from({ length: seconds }, (_value, index) =>
    createQuoteRow(startTs + index * 1_000, {
      bid_close: bidClose,
      ask_close: askClose,
      bid_open: bidClose,
      bid_high: bidClose,
      bid_low: bidClose,
      ask_open: askClose,
      ask_high: askClose,
      ask_low: askClose,
      is_interpolated: false,
    })
  )
}

describe('detectStalePrice', () => {
  it('returns pass when prices keep changing', () => {
    const startTs = Date.parse('2026-02-03T00:00:00.000Z')
    const rows = [
      createQuoteRow(startTs, { bid_close: 100, ask_close: 101 }),
      createQuoteRow(startTs + 1_000, { bid_close: 100.1, ask_close: 101.1 }),
      createQuoteRow(startTs + 2_000, { bid_close: 100.2, ask_close: 101.2 }),
    ]

    const result = detectStalePrice(rows)

    expect(result.status).toBe('pass')
    expect(result.runCount).toBe(0)
    expect(result.staleSeconds).toBe(0)
  })

  it('captures medium stale runs without failing', () => {
    const rows = buildFlatRows(Date.parse('2026-02-03T00:00:00.000Z'), 30)

    const result = detectStalePrice(rows)

    expect(result.status).toBe('pass')
    expect(result.longestRunSeconds).toBe(30)
    expect(result.runBuckets['10-60s']).toBe(1)
    expect(result.examples).toHaveLength(1)
  })

  it('fails on stale runs longer than five minutes', () => {
    const rows = buildFlatRows(Date.parse('2026-02-03T00:00:00.000Z'), 301)

    const result = detectStalePrice(rows)

    expect(result.status).toBe('fail')
    expect(result.longestRunSeconds).toBe(301)
    expect(result.runBuckets['>5m']).toBe(1)
  })

  it('ignores interpolated rows in stale calculations', () => {
    const rows = buildFlatRows(Date.parse('2026-02-03T00:00:00.000Z'), 120).map(row => ({
      ...row,
      is_interpolated: true,
    }))

    const result = detectStalePrice(rows)

    expect(result.status).toBe('pass')
    expect(result.runCount).toBe(0)
    expect(result.staleSeconds).toBe(0)
  })
})
