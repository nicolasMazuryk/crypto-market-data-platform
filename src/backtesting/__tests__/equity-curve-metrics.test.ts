import { beforeAll, describe, it, expect } from 'vitest'

import { computeEquityCurveMetrics } from '../reporting/equity-curve-metrics.js'
import type { EquityCurveMetrics } from '../reporting/types.js'

function requireResult(equity: number[]): EquityCurveMetrics {
  const r = computeEquityCurveMetrics(equity)
  if (r === null) throw new Error('Expected non-null EquityCurveMetrics')
  return r
}

describe('computeEquityCurveMetrics', () => {
  // Geometric (exponential) growth — the only curve where log-linear R² ≈ 1
  describe('geometric curve [1, 2, 4, 8, 16, 32]', () => {
    let result: EquityCurveMetrics
    beforeAll(() => {
      result = requireResult([1, 2, 4, 8, 16, 32])
    })

    it('returns non-null', () => {
      expect(result).not.toBeNull()
    })

    it('R² ≈ 1 (perfect log-linear fit for exponential growth)', () => {
      expect(result.r2).toBeGreaterThan(0.99)
    })

    it('K-Ratio > 0 (positive slope)', () => {
      expect(result.k_ratio).toBeGreaterThan(0)
    })

    it('Ulcer Index = 0 (never draws down)', () => {
      expect(result.ulcer_index).toBe(0)
    })

    it('Recovery Factor = Infinity (no drawdown)', () => {
      expect(result.recovery_factor).toBe(Infinity)
    })

    it('GPR = Infinity (no negative steps)', () => {
      expect(result.gain_to_pain_ratio).toBe(Infinity)
    })

    it('quality score in [0, 100]', () => {
      expect(result.equity_curve_quality_score).toBeGreaterThanOrEqual(0)
      expect(result.equity_curve_quality_score).toBeLessThanOrEqual(100)
    })
  })

  // Linear growth starting from 0 — the 0 is clamped in log space; R² is moderate
  describe('linear curve [0, 1, 2, 3, 4, 5]', () => {
    let result: EquityCurveMetrics
    beforeAll(() => {
      result = requireResult([0, 1, 2, 3, 4, 5])
    })

    it('returns non-null', () => {
      expect(result).not.toBeNull()
    })

    it('K-Ratio > 0 (positive slope)', () => {
      expect(result.k_ratio).toBeGreaterThan(0)
    })

    it('Ulcer Index = 0 (never draws down)', () => {
      expect(result.ulcer_index).toBe(0)
    })

    it('Recovery Factor = Infinity (no drawdown)', () => {
      expect(result.recovery_factor).toBe(Infinity)
    })

    it('GPR = Infinity (no negative steps)', () => {
      expect(result.gain_to_pain_ratio).toBe(Infinity)
    })

    it('quality score in [0, 100]', () => {
      expect(result.equity_curve_quality_score).toBeGreaterThanOrEqual(0)
      expect(result.equity_curve_quality_score).toBeLessThanOrEqual(100)
    })
  })

  describe('flat then crash [5, 5, 5, 5, 2, 1]', () => {
    let result: EquityCurveMetrics
    beforeAll(() => {
      result = requireResult([5, 5, 5, 5, 2, 1])
    })

    it('returns non-null', () => {
      expect(result).not.toBeNull()
    })

    it('R² degraded vs a smooth growing curve', () => {
      const smooth = requireResult([1, 2, 4, 8, 16, 32])
      expect(result.r2).toBeLessThan(smooth.r2)
    })

    it('K-Ratio < 0 (downward trend)', () => {
      expect(result.k_ratio).toBeLessThan(0)
    })

    it('Ulcer Index > 0 (equity spends time in drawdown)', () => {
      expect(result.ulcer_index).toBeGreaterThan(0)
    })

    it('Recovery Factor < 0 (net loss overall)', () => {
      expect(result.recovery_factor).toBeLessThan(0)
    })

    it('GPR < 1 (losses outweigh gains at step level)', () => {
      expect(result.gain_to_pain_ratio).toBeLessThan(1)
    })

    it('quality score in [0, 100]', () => {
      expect(result.equity_curve_quality_score).toBeGreaterThanOrEqual(0)
      expect(result.equity_curve_quality_score).toBeLessThanOrEqual(100)
    })
  })

  describe('edge cases', () => {
    it('returns null for N < 3', () => {
      expect(computeEquityCurveMetrics([])).toBeNull()
      expect(computeEquityCurveMetrics([1])).toBeNull()
      expect(computeEquityCurveMetrics([1, 2])).toBeNull()
    })

    it('throws for NaN in array', () => {
      expect(() => computeEquityCurveMetrics([1, NaN, 3])).toThrow()
    })

    it('throws for Infinity in array', () => {
      expect(() => computeEquityCurveMetrics([1, Infinity, 3])).toThrow()
    })

    it('throws for -Infinity in array', () => {
      expect(() => computeEquityCurveMetrics([1, -Infinity, 3])).toThrow()
    })

    it('Recovery Factor = Infinity when no drawdown occurs', () => {
      expect(requireResult([1, 2, 3, 4, 5]).recovery_factor).toBe(Infinity)
    })

    it('Serenity Ratio = Infinity when ulcer index is 0', () => {
      expect(requireResult([1, 2, 3, 4, 5]).serenity_ratio).toBe(Infinity)
    })

    it('GPR = Infinity when equity never declines', () => {
      expect(requireResult([1, 2, 3, 4, 5]).gain_to_pain_ratio).toBe(Infinity)
    })

    it('all scores in [0, 100] for edge infinity values', () => {
      const result = requireResult([1, 2, 3, 4, 5])
      for (const score of Object.values(result.scores)) {
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(100)
      }
    })
  })
})
