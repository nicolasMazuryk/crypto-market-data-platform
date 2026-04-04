import { describe, expect, it } from 'vitest'

import { assessInterpolationDamage } from '../validation/interpolation-damage.js'
import { createQuoteRow } from './validation-test-helpers.js'

describe('assessInterpolationDamage', () => {
  it('returns zero damage when no interpolation exists', () => {
    const startTs = Date.parse('2026-02-03T00:00:00.000Z')
    const rows = [
      createQuoteRow(startTs, { bid_close: 100, ask_close: 100 }),
      createQuoteRow(startTs + 1_000, { bid_close: 100.1, ask_close: 100.1 }),
    ]

    const result = assessInterpolationDamage(rows)

    expect(result.boundaryCount).toBe(0)
    expect(result.damageScore).toBe(0)
    expect(result.highDamageCount).toBe(0)
  })

  it('measures zero change at interpolation boundaries', () => {
    const startTs = Date.parse('2026-02-03T00:00:00.000Z')
    const rows = [
      createQuoteRow(startTs, { bid_close: 100, ask_close: 100 }),
      createQuoteRow(startTs + 1_000, { bid_close: 100, ask_close: 100, is_interpolated: true }),
      createQuoteRow(startTs + 2_000, { bid_close: 100, ask_close: 100 }),
    ]

    const result = assessInterpolationDamage(rows)

    expect(result.boundaryCount).toBe(1)
    expect(result.damageScore).toBe(0)
    expect(result.highDamageCount).toBe(0)
  })

  it('flags high-damage boundaries above 0.5%', () => {
    const startTs = Date.parse('2026-02-03T00:00:00.000Z')
    const rows = [
      createQuoteRow(startTs, { bid_close: 100, ask_close: 100 }),
      createQuoteRow(startTs + 1_000, { bid_close: 100, ask_close: 100, is_interpolated: true }),
      createQuoteRow(startTs + 2_000, { bid_close: 101, ask_close: 101 }),
    ]

    const result = assessInterpolationDamage(rows)

    expect(result.boundaryCount).toBe(1)
    expect(result.damageScore).toBeCloseTo(1, 6)
    expect(result.highDamageCount).toBe(1)
    expect(result.maxBoundaryChangePercent).toBeCloseTo(1, 6)
  })
})
