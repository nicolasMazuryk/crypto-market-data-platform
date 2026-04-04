import { describe, expect, it } from 'vitest'

import { validateTimestampAlignment } from '../validation/timestamp-alignment.js'
import { createQuoteRow } from './validation-test-helpers.js'

describe('validateTimestampAlignment', () => {
  it('passes when first and last timestamps are day-aligned', () => {
    const rows = [
      createQuoteRow(Date.parse('2026-02-03T00:00:00.000Z')),
      createQuoteRow(Date.parse('2026-02-03T23:59:59.000Z')),
    ]

    const result = validateTimestampAlignment(rows)

    expect(result.pass).toBe(true)
    expect(result.firstOffsetSeconds).toBe(0)
    expect(result.lastOffsetSeconds).toBe(0)
  })

  it('reports offsets when timestamps are not day-aligned', () => {
    const rows = [
      createQuoteRow(Date.parse('2026-02-03T00:00:05.000Z')),
      createQuoteRow(Date.parse('2026-02-03T23:59:50.000Z')),
    ]

    const result = validateTimestampAlignment(rows)

    expect(result.pass).toBe(false)
    expect(result.firstOffsetSeconds).toBe(5)
    expect(result.lastOffsetSeconds).toBe(9)
  })

  it('returns non-pass result for empty rows', () => {
    const result = validateTimestampAlignment([])

    expect(result.pass).toBe(false)
    expect(result.firstTs).toBeNull()
    expect(result.lastTs).toBeNull()
    expect(result.firstOffsetSeconds).toBeNull()
    expect(result.lastOffsetSeconds).toBeNull()
  })
})
