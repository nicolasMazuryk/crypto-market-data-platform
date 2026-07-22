/**
 * strategy_6 canary acceptance metrics + gate evaluator — §6.2.2 (docs-strategy/strategies/07_strategy_6.md).
 * Thresholds are pre-registered here (not per-deploy config) so the gate is code-reviewable
 * and cannot be loosened silently via a config edit.
 */

/** Pre-registered canary acceptance thresholds, §6.2.2 (a)-(e). */
export const STRATEGY_6_CANARY_THRESHOLDS = {
  /** (a) funding_event_timeout rate must be ≤ this multiple of the shadow-phase miss estimate. */
  fundingEventTimeoutRateMultiplier: 2,
  /** (b) MAIN slippage p90 must be ≤ this multiple of the assumed market_slippage_pct. */
  mainSlippageP90Multiplier: 2,
} as const

/** Collected canary-phase metrics, one row per evaluation window. */
export interface Strategy6CanaryMetrics {
  /** (a) */
  fundingEventTimeoutCount: number
  totalMainAttempts: number
  shadowPhaseMissEstimateRate: number
  /** (b) */
  mainSlippagePctP90: number
  assumedMarketSlippagePct: number
  /** (c) — informational, no hard threshold; reported for the canary review. */
  realizedPreOverheadBp: number
  /** (d) — informational audit outcome; true only when funding attribution reconciles per venue. */
  fundingAttributionAuditPassed: boolean
  /** (e) */
  closePreFundingFailedCount: number
}

export type CanaryBreach = 'funding_event_timeout_rate' | 'main_slippage_p90' | 'funding_attribution_audit'

export interface CanaryGateResult {
  pass: boolean
  /** True the moment (e) is breached — canary must halt immediately, independent of `pass`. */
  halt: boolean
  breaches: CanaryBreach[]
}

/**
 * Evaluate a canary metrics window against the pre-registered §6.2.2 thresholds.
 * (e) `close_pre_funding_failed` > 0 is an immediate halt regardless of the other metrics.
 */
export function evaluateStrategy6CanaryGate(metrics: Strategy6CanaryMetrics): CanaryGateResult {
  const breaches: CanaryBreach[] = []

  if (metrics.closePreFundingFailedCount > 0) {
    return { pass: false, halt: true, breaches: [] }
  }

  const timeoutRate = metrics.totalMainAttempts > 0 ? metrics.fundingEventTimeoutCount / metrics.totalMainAttempts : 0
  const timeoutCeiling =
    metrics.shadowPhaseMissEstimateRate * STRATEGY_6_CANARY_THRESHOLDS.fundingEventTimeoutRateMultiplier
  if (timeoutRate > timeoutCeiling) breaches.push('funding_event_timeout_rate')

  const slippageCeiling =
    metrics.assumedMarketSlippagePct * STRATEGY_6_CANARY_THRESHOLDS.mainSlippageP90Multiplier
  if (metrics.mainSlippagePctP90 > slippageCeiling) breaches.push('main_slippage_p90')

  if (!metrics.fundingAttributionAuditPassed) breaches.push('funding_attribution_audit')

  return { pass: breaches.length === 0, halt: false, breaches }
}
