import { toClickHouseDateTime } from '../../db/types.js'
import { detectRealFundingSettlement } from '../data/funding-settlement.js'
import type { DropDetectionParams } from '../data/funding-settlement.js'
import type { OHLCWindow } from '../data/types.js'
import type { LookaheadContext } from '../strategies/types.js'
import { TimeGatedWindow } from './lookahead-guard.js'

/**
 * Perform the one sanctioned lookahead (§3.2): localize T_drop over the raw window, then wrap
 * the window in a time-gated view for the strategy. The gate starts at the window's first
 * timestamp so strategies advance forward as they read; the drop localization itself is done
 * here on the raw window, not through the gate.
 */
export function buildLookaheadContext(
  window: OHLCWindow,
  fundingTime: Date,
  fundingRate: number,
  params: DropDetectionParams
): LookaheadContext {
  const settlement = detectRealFundingSettlement(window, fundingTime, fundingRate, params)
  const initialTs = window.getFirstTs() ?? toClickHouseDateTime(fundingTime)
  const gated = new TimeGatedWindow(window, initialTs)
  return {
    tDropTs: settlement.settlementTs,
    noDropLocalized: settlement.noDropLocalized,
    gated,
  }
}

/** `(T_drop − T_settle)` in seconds, or `null` when no drop was localized (fallback edge used). */
export function computeTDropOffsetSeconds(context: LookaheadContext, fundingTime: Date): number | null {
  if (context.noDropLocalized) return null
  const tDropMs = new Date(context.tDropTs.replace(' ', 'T') + 'Z').getTime()
  return (tDropMs - fundingTime.getTime()) / 1000
}
