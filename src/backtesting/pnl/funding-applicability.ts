import type { ClickHouseDateTime } from '../../db/types.js'
import type { Fill } from '../orders/types.js'

export function shouldApplyFunding(params: {
  entryTs: ClickHouseDateTime
  exitTs: ClickHouseDateTime
  fundingTs: ClickHouseDateTime
  fundingAppliedOnSameSecond: boolean
}): boolean {
  const { entryTs, exitTs, fundingTs, fundingAppliedOnSameSecond } = params
  if (entryTs > fundingTs) return false
  if (exitTs < fundingTs) return false
  if (entryTs === fundingTs || exitTs === fundingTs) return fundingAppliedOnSameSecond
  return true
}

/** Convenience boolean → fraction for non-ladder callers. */
export function fundingFraction(applied: boolean): number {
  return applied ? 1 : 0
}

/**
 * Proportional accrual for ladder strategies.
 *
 * Each fill is treated as opening a sub-position; all sub-positions close together
 * at exitTs. A sub-position accrues funding iff shouldApplyFunding holds for its
 * (fill.timestamp, exitTs) pair. Returns weighted fraction in [0, 1].
 */
export function fundingFractionForLadder(params: {
  fills: readonly Pick<Fill, 'timestamp' | 'quantity'>[]
  exitTs: ClickHouseDateTime
  fundingTs: ClickHouseDateTime
  fundingAppliedOnSameSecond: boolean
}): number {
  const { fills, exitTs, fundingTs, fundingAppliedOnSameSecond } = params
  let totalQty = 0
  let appliedQty = 0
  for (const fill of fills) {
    totalQty += fill.quantity
    if (
      shouldApplyFunding({
        entryTs: fill.timestamp,
        exitTs,
        fundingTs,
        fundingAppliedOnSameSecond,
      })
    ) {
      appliedQty += fill.quantity
    }
  }
  if (totalQty === 0) return 0
  return appliedQty / totalQty
}
