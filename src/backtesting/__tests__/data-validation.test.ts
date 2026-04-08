import { describe, it, expect } from 'vitest'
import type { OrderbookRow } from '../../db/types.js'
import { OHLCWindow } from '../data/types.js'
import { validateEventData } from '../data/validation.js'
import type { ValidationConfig } from '../config/schema.js'

function makeCandle(ts: string, price: number): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts,
    bid_open: price,
    bid_high: price * 1.001,
    bid_low: price * 0.999,
    bid_close: price,
    ask_open: price * 1.0001,
    ask_high: price * 1.0011,
    ask_low: price * 0.9991,
    ask_close: price * 1.0001,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
  }
}

const defaultValidation: ValidationConfig = {
  required_seconds_before: 5,
  required_seconds_after: 10,
  max_gap_seconds: 3,
  max_price_change_pct: 0.2,
}

describe('Data Validation', () => {
  it('passes for complete data', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const rows: OrderbookRow[] = []

    // Generate [T-60, T+120] with every second
    for (let i = -60; i <= 120; i++) {
      const ts = new Date(fundingTime.getTime() + i * 1000)
      const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
      rows.push(makeCandle(tsStr, 50000))
    }

    const window = new OHLCWindow(rows)
    const result = validateEventData(window, fundingTime, defaultValidation)
    expect(result.valid).toBe(true)
    expect(result.skipReasons).toHaveLength(0)
  })

  it('fails for missing seconds in required window', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const rows: OrderbookRow[] = []

    // Generate seconds but skip T-3 (which is in required window [T-5, T+10])
    for (let i = -60; i <= 120; i++) {
      if (i === -3) continue // skip one required second
      const ts = new Date(fundingTime.getTime() + i * 1000)
      const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
      rows.push(makeCandle(tsStr, 50000))
    }

    const window = new OHLCWindow(rows)
    const result = validateEventData(window, fundingTime, defaultValidation)
    expect(result.valid).toBe(false)
    expect(result.skipReasons).toContain('MISSING_SECONDS')
  })

  it('fails for staleness gap overlapping required window', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const rows: OrderbookRow[] = []

    // Generate with a 5-second gap at T-2 to T+2
    for (let i = -60; i <= 120; i++) {
      if (i >= -2 && i <= 2) continue
      const ts = new Date(fundingTime.getTime() + i * 1000)
      const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
      rows.push(makeCandle(tsStr, 50000))
    }

    const window = new OHLCWindow(rows)
    const result = validateEventData(window, fundingTime, defaultValidation)
    expect(result.valid).toBe(false)
    expect(result.skipReasons).toContain('MISSING_SECONDS')
  })

  it('fails for price anomaly > 20%', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const rows: OrderbookRow[] = []

    for (let i = -60; i <= 120; i++) {
      const ts = new Date(fundingTime.getTime() + i * 1000)
      const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
      // Huge price jump at T+5
      const price = i < 5 ? 50000 : 65000
      rows.push(makeCandle(tsStr, price))
    }

    const window = new OHLCWindow(rows)
    const result = validateEventData(window, fundingTime, defaultValidation)
    expect(result.valid).toBe(false)
    expect(result.skipReasons).toContain('PRICE_ANOMALY')
  })

  it('fails for empty window', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const window = new OHLCWindow([])
    const result = validateEventData(window, fundingTime, defaultValidation)
    expect(result.valid).toBe(false)
    expect(result.skipReasons).toContain('EMPTY_WINDOW')
  })

  it('fails for null prices', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const rows: OrderbookRow[] = []

    for (let i = -60; i <= 120; i++) {
      const ts = new Date(fundingTime.getTime() + i * 1000)
      const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
      rows.push({
        ...makeCandle(tsStr, 50000),
        bid_open: null,
        bid_high: null,
        bid_low: null,
        bid_close: null,
        ask_open: null,
        ask_high: null,
        ask_low: null,
        ask_close: null,
      })
    }

    const window = new OHLCWindow(rows)
    const result = validateEventData(window, fundingTime, defaultValidation)
    expect(result.valid).toBe(false)
    expect(result.skipReasons).toContain('NULL_PRICES')
  })
})
