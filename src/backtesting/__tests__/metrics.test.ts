import { describe, it, expect } from 'vitest'
import {
  mean,
  median,
  stdDev,
  skewness,
  kurtosis,
  sharpeRatio,
  sortinoRatio,
  maxDrawdown,
  profitFactor,
  calmarRatio,
  expectancy,
} from '../reporting/metrics.js'

const TOLERANCE = 1e-8

describe('Metrics', () => {
  describe('mean', () => {
    it('computes average', () => {
      expect(mean([1, 2, 3, 4, 5])).toBe(3)
    })
    it('handles empty array', () => {
      expect(mean([])).toBe(0)
    })
  })

  describe('median', () => {
    it('odd count', () => {
      expect(median([1, 2, 3, 4, 5])).toBe(3)
    })
    it('even count', () => {
      expect(median([1, 2, 3, 4])).toBe(2.5)
    })
    it('handles empty array', () => {
      expect(median([])).toBe(0)
    })
    it('unsorted input', () => {
      expect(median([5, 1, 3])).toBe(3)
    })
  })

  describe('stdDev', () => {
    it('computes population standard deviation', () => {
      const result = stdDev([2, 4, 4, 4, 5, 5, 7, 9])
      expect(result).toBeCloseTo(2, 4)
    })
    it('handles single value', () => {
      expect(stdDev([5])).toBe(0)
    })
  })

  describe('profitFactor', () => {
    it('gross profits / gross losses', () => {
      const returns = [0.01, -0.005, 0.02, -0.003]
      const pf = profitFactor(returns)
      expect(pf).toBeCloseTo(0.03 / 0.008, TOLERANCE)
    })
    it('infinite when no losses', () => {
      expect(profitFactor([0.01, 0.02])).toBe(Infinity)
    })
    it('zero when no profits', () => {
      expect(profitFactor([-0.01, -0.02])).toBe(0)
    })
  })

  describe('maxDrawdown', () => {
    it('computes correctly for a simple sequence', () => {
      // Cumulative PnL: [0.01, 0.02, 0.005, -0.005, 0.03]
      // Peak at 0.02, trough at -0.005 → drawdown = 0.025
      const result = maxDrawdown([0.01, 0.02, 0.005, -0.005, 0.03])
      expect(result.maxDrawdownPct).toBeCloseTo(0.025, TOLERANCE)
    })
    it('zero drawdown for monotonically increasing', () => {
      const result = maxDrawdown([0.01, 0.02, 0.03])
      expect(result.maxDrawdownPct).toBe(0)
    })
    it('handles empty array', () => {
      const result = maxDrawdown([])
      expect(result.maxDrawdownPct).toBe(0)
    })
  })

  describe('sharpeRatio', () => {
    it('positive for all positive returns', () => {
      const result = sharpeRatio([0.001, 0.002, 0.001, 0.003])
      expect(result).toBeGreaterThan(0)
    })
    it('handles zero std dev', () => {
      const result = sharpeRatio([0.001, 0.001, 0.001])
      expect(result).toBe(Infinity)
    })
  })

  describe('sortinoRatio', () => {
    it('positive for mostly positive returns', () => {
      const result = sortinoRatio([0.01, -0.002, 0.008, 0.005])
      expect(result).toBeGreaterThan(0)
    })
    it('infinity when no negative returns', () => {
      const result = sortinoRatio([0.01, 0.02, 0.005])
      expect(result).toBe(Infinity)
    })
  })

  describe('calmarRatio', () => {
    it('computes annualized return / max drawdown', () => {
      const returns = [0.001, -0.002, 0.003, 0.001]
      const result = calmarRatio(returns, 0.002)
      // Total return = 0.003, annualized = (0.003/4)*1095 = 0.82125
      // Calmar = 0.82125 / 0.002 = 410.625
      expect(result).toBeCloseTo(410.625, 2)
    })
    it('zero when max drawdown is zero', () => {
      expect(calmarRatio([0.01], 0)).toBe(0)
    })
  })

  describe('expectancy', () => {
    it('computes (win_rate * avg_win) - (loss_rate * avg_loss)', () => {
      const returns = [0.01, -0.005, 0.02, -0.003]
      // 2 wins (avg 0.015), 2 losses (avg 0.004)
      // Expectancy = 0.5 * 0.015 - 0.5 * 0.004 = 0.0075 - 0.002 = 0.0055
      const result = expectancy(returns)
      expect(result).toBeCloseTo(0.0055, TOLERANCE)
    })
  })

  describe('skewness', () => {
    it('returns 0 for insufficient data', () => {
      expect(skewness([1])).toBe(0)
      expect(skewness([1, 2])).toBe(0)
    })
    it('returns non-zero for skewed data', () => {
      // Right-skewed
      const result = skewness([1, 1, 1, 1, 10])
      expect(result).toBeGreaterThan(0)
    })
  })

  describe('kurtosis', () => {
    it('returns 0 for insufficient data', () => {
      expect(kurtosis([1, 2, 3])).toBe(0)
    })
    it('returns negative for uniform-like distribution', () => {
      // Uniform distribution has kurtosis ~ -1.2
      const result = kurtosis([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(result).toBeLessThan(0)
    })
  })
})
