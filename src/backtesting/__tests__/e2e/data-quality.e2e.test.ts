import { describe, it, expect } from 'vitest'
import type { OrderbookRow } from '../../../db/types.js'
import { OHLCWindow } from '../../data/types.js'
import { validateEventData } from '../../data/validation.js'
import type { ValidationConfig } from '../../config/schema.js'

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

describe('E2E: Data Quality Scenarios', () => {
  it('Scenario 16: Missing second in required window — event skipped', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const rows: OrderbookRow[] = []

    // Build complete window but skip T+3 (inside required [T-5, T+10])
    for (let i = -60; i <= 120; i++) {
      if (i === 3) continue // Missing second
      const ts = new Date(fundingTime.getTime() + i * 1000)
      const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
      rows.push(makeCandle(tsStr, 50000))
    }

    const window = new OHLCWindow(rows)
    const result = validateEventData(window, fundingTime, defaultValidation)

    expect(result.valid).toBe(false)
    expect(result.skipReasons).toContain('MISSING_SECONDS')
  })

  it('Scenario 18: Empty data window — skipped cleanly', () => {
    const fundingTime = new Date('2025-06-01T00:00:00Z')
    const window = new OHLCWindow([])
    const result = validateEventData(window, fundingTime, defaultValidation)

    expect(result.valid).toBe(false)
    expect(result.skipReasons).toContain('EMPTY_WINDOW')
  })
})
