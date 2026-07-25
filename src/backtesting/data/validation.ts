import type { ValidationConfig } from '../config/schema.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { OHLCWindow, SkipReason } from './types.js'

export function validateEventData(
  window: OHLCWindow,
  fundingTime: Date,
  config: ValidationConfig
): { valid: boolean; skipReasons: SkipReason[] } {
  const skipReasons: SkipReason[] = []

  if (window.length === 0) {
    return { valid: false, skipReasons: ['EMPTY_WINDOW'] }
  }

  const rows = window.getAll()

  // Check for null prices
  const hasNullPrices = rows.some(r => r.bid_open === null || r.ask_open === null)
  if (hasNullPrices) {
    skipReasons.push('NULL_PRICES')
  }

  // Check every second in required window [T-before, T+after] is present
  const requiredStart = new Date(fundingTime.getTime() - config.required_seconds_before * 1000)
  const requiredEnd = new Date(fundingTime.getTime() + config.required_seconds_after * 1000)

  for (let t = requiredStart.getTime(); t <= requiredEnd.getTime(); t += 1000) {
    const ts = toClickHouseDateTime(new Date(t))
    if (!window.hasTimestamp(ts)) {
      skipReasons.push('MISSING_SECONDS')
      break
    }
  }

  // Check for stale data: consecutive rows with gaps > max_gap_seconds
  for (let i = 1; i < rows.length; i++) {
    const prevRow = rows[i - 1]
    const currRow = rows[i]
    if (!prevRow || !currRow) break
    if ((new Date(currRow.ts).getTime() - new Date(prevRow.ts).getTime()) / 1000 > config.max_gap_seconds) {
      skipReasons.push('STALE_DATA')
      break
    }
  }

  // Check for price anomaly across the full window. Scan every price field
  // that order fills can actually read (fillMarketOrder uses bid_open/ask_open),
  // not just bid_close — a spike isolated to the open side of a single candle
  // must still be caught even when close prices look normal.
  let minPrice = Infinity
  let maxPrice = -Infinity
  for (const row of rows) {
    for (const price of [row.bid_open, row.ask_open, row.bid_close, row.ask_close]) {
      if (price !== null) {
        if (price < minPrice) minPrice = price
        if (price > maxPrice) maxPrice = price
      }
    }
  }
  if (minPrice > 0 && maxPrice > 0 && (maxPrice - minPrice) / minPrice > config.max_price_change_pct) {
    skipReasons.push('PRICE_ANOMALY')
  }

  return { valid: skipReasons.length === 0, skipReasons }
}
