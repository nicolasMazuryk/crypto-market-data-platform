import { describe, expect, it } from 'vitest'

import { dayEndMs, dayStartMs, partitionByDay, tsToDateString } from '../validation/day-utils.js'
import { createQuoteRow } from './validation-test-helpers.js'

describe('day-utils', () => {
  it('formats timestamps to UTC calendar date strings', () => {
    const ts = Date.parse('2026-02-03T15:04:05.000Z')
    expect(tsToDateString(ts)).toBe('2026-02-03')
  })

  it('computes UTC day start and day end timestamps', () => {
    expect(dayStartMs('2026-02-03')).toBe(Date.parse('2026-02-03T00:00:00.000Z'))
    expect(dayEndMs('2026-02-03')).toBe(Date.parse('2026-02-03T23:59:59.000Z'))
  })

  it('partitions sorted rows by UTC day', () => {
    const rows = [
      createQuoteRow(Date.parse('2026-02-03T23:59:58.000Z')),
      createQuoteRow(Date.parse('2026-02-03T23:59:59.000Z')),
      createQuoteRow(Date.parse('2026-02-04T00:00:00.000Z')),
    ]

    const byDay = partitionByDay(rows)

    expect([...byDay.keys()]).toEqual(['2026-02-03', '2026-02-04'])
    expect(byDay.get('2026-02-03')).toHaveLength(2)
    expect(byDay.get('2026-02-04')).toHaveLength(1)
  })
})
