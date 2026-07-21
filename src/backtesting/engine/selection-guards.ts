import type { FundingEvent } from '../data/types.js'

/**
 * Sort events by funding rate, most negative first.
 * This implements §9 selection priority.
 */
export function sortMostNegativeFirst(events: FundingEvent[]): FundingEvent[] {
  return [...events].sort((a, b) => a.funding_rate - b.funding_rate)
}

/**
 * Check if absolute funding rate is within threshold band.
 * §9 0.1pp band guard: ensures abs(funding_rate) >= threshold.
 */
export function isWithinThresholdBand(absRatePercent: number, thresholdPercent: number): boolean {
  return absRatePercent >= thresholdPercent
}

/**
 * Check if snapshot age is acceptable (≤ 60 seconds).
 * §9 60s staleness guard for selection decisions.
 * In backtest, staleness is always 0 (settled rate at decision instant).
 */
export function isSnapshotFresh(ageSeconds: number): boolean {
  const MAX_STALENESS_S = 60
  return ageSeconds <= MAX_STALENESS_S
}
