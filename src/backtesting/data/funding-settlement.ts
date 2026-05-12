import type { ClickHouseDateTime } from '../../db/types.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { OHLCWindow } from './types.js'

export interface FundingSettlementResult {
  settlementTs: ClickHouseDateTime
  detected: boolean
  dropMagnitude: number | null
}

/**
 * Detect real funding settlement time from the biggest 1-second bid price drop
 * in [fundingTime, fundingTime + windowSeconds]. Falls back to fundingTime if
 * no red candle (bid_open > bid_low) is found.
 */
export function detectRealFundingSettlement(
  data: OHLCWindow,
  fundingTime: Date,
  windowSeconds: number
): FundingSettlementResult {
  const fundingTs = toClickHouseDateTime(fundingTime)
  const endTs = toClickHouseDateTime(new Date(fundingTime.getTime() + windowSeconds * 1000))
  const rows = data.getRowsInRange(fundingTs, endTs)

  let bestDrop = 0
  let bestTs: ClickHouseDateTime | null = null

  for (const row of rows) {
    if (row.bid_open == null || row.bid_low == null) continue
    const drop = row.bid_open - row.bid_low
    if (drop > bestDrop) {
      bestDrop = drop
      bestTs = row.ts
    }
  }

  if (bestTs === null) {
    return { settlementTs: fundingTs, detected: false, dropMagnitude: null }
  }
  return { settlementTs: bestTs, detected: true, dropMagnitude: bestDrop }
}
