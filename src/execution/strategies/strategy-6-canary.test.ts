import { describe, expect, it } from 'vitest'

import { evaluateStrategy6CanaryGate, type Strategy6CanaryMetrics } from './strategy-6-canary.js'

function makeMetrics(overrides: Partial<Strategy6CanaryMetrics> = {}): Strategy6CanaryMetrics {
  return {
    fundingEventTimeoutCount: 1,
    totalMainAttempts: 100,
    shadowPhaseMissEstimateRate: 0.02,
    mainSlippagePctP90: 0.1,
    assumedMarketSlippagePct: 0.1,
    realizedPreOverheadBp: 5,
    fundingAttributionAuditPassed: true,
    closePreFundingFailedCount: 0,
    ...overrides,
  }
}

describe('evaluateStrategy6CanaryGate', () => {
  it('a clean metrics set passes with no breaches', () => {
    const result = evaluateStrategy6CanaryGate(makeMetrics())
    expect(result).toEqual({ pass: true, halt: false, breaches: [] })
  })

  it('(e) close_pre_funding_failed > 0 halts immediately, independent of other metrics', () => {
    const result = evaluateStrategy6CanaryGate(makeMetrics({ closePreFundingFailedCount: 1 }))
    expect(result.halt).toBe(true)
    expect(result.pass).toBe(false)
  })

  it('(a) funding_event_timeout rate above 2x the shadow miss estimate breaches', () => {
    // shadow estimate 2% -> ceiling 4%; 10/100 = 10% breaches
    const result = evaluateStrategy6CanaryGate(
      makeMetrics({ fundingEventTimeoutCount: 10, totalMainAttempts: 100, shadowPhaseMissEstimateRate: 0.02 })
    )
    expect(result.pass).toBe(false)
    expect(result.halt).toBe(false)
    expect(result.breaches).toContain('funding_event_timeout_rate')
  })

  it('(b) MAIN slippage p90 above 2x assumed breaches', () => {
    const result = evaluateStrategy6CanaryGate(makeMetrics({ mainSlippagePctP90: 0.25, assumedMarketSlippagePct: 0.1 }))
    expect(result.pass).toBe(false)
    expect(result.breaches).toContain('main_slippage_p90')
  })

  it('(d) failed funding-attribution audit breaches', () => {
    const result = evaluateStrategy6CanaryGate(makeMetrics({ fundingAttributionAuditPassed: false }))
    expect(result.pass).toBe(false)
    expect(result.breaches).toContain('funding_attribution_audit')
  })
})
