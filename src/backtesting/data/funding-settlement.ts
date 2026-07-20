import type { ClickHouseDateTime } from '../../db/types.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { OHLCWindow } from './types.js'

export interface FundingSettlementResult {
  /** Localized T_drop, or the window edge (T_settle + dropSearchWindowSeconds) on fallback. */
  settlementTs: ClickHouseDateTime
  /** True when a qualifying drop candle was localized. Inverse of `noDropLocalized`. */
  detected: boolean
  /** True when no candidate qualified and the fallback edge was used. */
  noDropLocalized: boolean
}

export interface DropDetectionParams {
  /** Search window length (seconds) after T_settle. */
  dropSearchWindowSeconds: number
  /** |F|-scaled qualifier term multiplier. */
  dropQualifierFundingMult: number
  /** R_pre-scaled qualifier term multiplier. */
  dropQualifierRangeMult: number
}

function parseTs(ts: ClickHouseDateTime): number {
  return new Date(ts.replace(' ', 'T') + 'Z').getTime()
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid] ?? 0
  if (sorted.length % 2 === 1) return hi
  const lo = sorted[mid - 1] ?? hi
  return (lo + hi) / 2
}

/**
 * Localize the real funding settlement time (§3.1) as the T_drop timestamp of the
 * qualifying bid-price drop candle in W = [T_settle, T_settle + dropSearchWindowSeconds].
 *
 * For each candle c (using the previous 1s bid_close as `prev_close`):
 *   drop_move(c) = (prev_close − bid_low) / prev_close × 100
 *   red_range(c) = (bid_high − bid_low) / bid_open × 100  if bid_close < bid_open, else 0
 *   R_pre        = median over [T_settle−30s, T_settle−1s] of (bid_high − bid_low)/bid_open × 100
 *   Q            = max(dropQualifierFundingMult · |F| · 100, dropQualifierRangeMult · R_pre)
 *
 * The candidate set is { c in W : drop_move(c) ≥ Q }; T_drop is the argmax drop_move,
 * tie-broken by larger red_range then earlier candle. On an empty candidate set the
 * fallback is the *latest* edge (T_settle + dropSearchWindowSeconds) with noDropLocalized.
 */
export function detectRealFundingSettlement(
  data: OHLCWindow,
  fundingTime: Date,
  fundingRate: number,
  params: DropDetectionParams
): FundingSettlementResult {
  const { dropSearchWindowSeconds, dropQualifierFundingMult, dropQualifierRangeMult } = params
  const fundingMs = fundingTime.getTime()
  const fundingTs = toClickHouseDateTime(fundingTime)
  const endTs = toClickHouseDateTime(new Date(fundingMs + dropSearchWindowSeconds * 1000))

  // R_pre: median 1s range% over [T_settle−30s, T_settle−1s].
  const preStartTs = toClickHouseDateTime(new Date(fundingMs - 30_000))
  const preEndTs = toClickHouseDateTime(new Date(fundingMs - 1000))
  const preRanges: number[] = []
  for (const r of data.getRowsInRange(preStartTs, preEndTs)) {
    if (r.bid_high == null || r.bid_low == null || r.bid_open == null || r.bid_open === 0) continue
    preRanges.push(((r.bid_high - r.bid_low) / r.bid_open) * 100)
  }
  const rPre = median(preRanges)

  const q = Math.max(dropQualifierFundingMult * Math.abs(fundingRate) * 100, dropQualifierRangeMult * rPre)

  let best: { ts: ClickHouseDateTime; dropMove: number; redRange: number } | null = null
  for (const row of data.getRowsInRange(fundingTs, endTs)) {
    if (row.bid_low == null || row.bid_open == null) continue
    const prevTs = toClickHouseDateTime(new Date(parseTs(row.ts) - 1000))
    const prev = data.getRowAt(prevTs)
    if (prev?.bid_close == null || prev.bid_close === 0) continue

    const dropMove = ((prev.bid_close - row.bid_low) / prev.bid_close) * 100
    if (dropMove < q) continue

    const redRange =
      row.bid_close != null && row.bid_high != null && row.bid_close < row.bid_open
        ? ((row.bid_high - row.bid_low) / row.bid_open) * 100
        : 0

    if (
      best === null ||
      dropMove > best.dropMove ||
      (dropMove === best.dropMove && redRange > best.redRange)
    ) {
      best = { ts: row.ts, dropMove, redRange }
    }
  }

  if (best === null) {
    return { settlementTs: endTs, detected: false, noDropLocalized: true }
  }
  return { settlementTs: best.ts, detected: true, noDropLocalized: false }
}
