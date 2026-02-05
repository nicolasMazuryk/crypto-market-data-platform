import { describe, expect, it } from 'vitest'

import { extractListingDate } from './listing-date.js'

describe('extractListingDate', () => {
  it('returns null when info is missing', () => {
    expect(extractListingDate('binance')).toBeNull()
  })

  it('parses seconds-based timestamps for exchange-specific fields', () => {
    const date = extractListingDate('binance', { onboardDate: 1700000000 })

    expect(date?.toISOString()).toBe(
      new Date(1700000000 * 1000).toISOString()
    )
  })

  it('falls back to default fields when exchange-specific data is invalid', () => {
    const date = extractListingDate('binance', {
      onboardDate: 0,
      listingTime: 1700000000000
    })

    expect(date?.toISOString()).toBe(
      new Date(1700000000000).toISOString()
    )
  })

  it('parses ISO date strings for OKX listing times', () => {
    const date = extractListingDate('okx', {
      listTime: '2025-01-01T00:00:00Z'
    })

    expect(date?.toISOString()).toBe('2025-01-01T00:00:00.000Z')
  })

  it('uses default field names when exchange-specific ones are missing', () => {
    const date = extractListingDate('gateio', {
      openTime: '1700000000'
    })

    expect(date?.toISOString()).toBe(
      new Date(1700000000 * 1000).toISOString()
    )
  })
})
