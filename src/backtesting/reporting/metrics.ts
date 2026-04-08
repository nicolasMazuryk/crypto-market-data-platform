/**
 * Pure metric calculation functions.
 * All assume trade P&L values as fractions (e.g., 0.005 = 0.5%).
 */

/** Calculate mean of an array */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** Calculate median of an array */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  }
  return sorted[mid] ?? 0
}

/** Calculate standard deviation (population) */
export function stdDev(values: number[]): number {
  if (values.length <= 1) return 0
  const avg = mean(values)
  let sumSq = 0
  for (const v of values) sumSq += (v - avg) ** 2
  return Math.sqrt(sumSq / values.length)
}

/** Calculate skewness */
export function skewness(values: number[]): number {
  if (values.length <= 2) return 0
  const avg = mean(values)
  const sd = stdDev(values)
  if (sd === 0) return 0
  const n = values.length
  let sum = 0
  for (const v of values) sum += ((v - avg) / sd) ** 3
  return (n / ((n - 1) * (n - 2))) * sum
}

/** Calculate excess kurtosis */
export function kurtosis(values: number[]): number {
  if (values.length <= 3) return 0
  const avg = mean(values)
  const sd = stdDev(values)
  if (sd === 0) return 0
  const n = values.length
  let sum = 0
  for (const v of values) sum += ((v - avg) / sd) ** 4
  const rawKurtosis = sum / n
  return rawKurtosis - 3
}

/**
 * Calculate Sharpe ratio (annualized, risk-free = 0).
 * Assumes 3 funding events per day (8-hour intervals) = ~1095 per year.
 */
export function sharpeRatio(returns: number[], periodsPerYear = 1095): number {
  if (returns.length <= 1) return 0
  const avg = mean(returns)
  const sd = stdDev(returns)
  if (sd === 0) return avg > 0 ? Infinity : avg < 0 ? -Infinity : 0
  return (avg / sd) * Math.sqrt(periodsPerYear)
}

/**
 * Calculate Sortino ratio (annualized, risk-free = 0).
 * Uses downside deviation instead of standard deviation.
 */
export function sortinoRatio(returns: number[], periodsPerYear = 1095): number {
  if (returns.length <= 1) return 0
  const avg = mean(returns)
  const negativeReturns = returns.filter(r => r < 0)
  if (negativeReturns.length === 0) return avg > 0 ? Infinity : 0

  let sumSqNeg = 0
  for (const r of negativeReturns) sumSqNeg += r ** 2
  const downsideDev = Math.sqrt(sumSqNeg / returns.length)

  if (downsideDev === 0) return avg > 0 ? Infinity : 0
  return (avg / downsideDev) * Math.sqrt(periodsPerYear)
}

/**
 * Calculate maximum drawdown from cumulative P&L.
 * Returns { maxDrawdownPct, maxDrawdownDurationSeconds }.
 */
export function maxDrawdown(cumulativePnls: number[]): {
  maxDrawdownPct: number
  maxDrawdownDurationSeconds: number
} {
  if (cumulativePnls.length === 0) {
    return { maxDrawdownPct: 0, maxDrawdownDurationSeconds: 0 }
  }

  let peak = 0
  let maxDd = 0
  let maxDdDuration = 0
  let currentDdStart = 0

  for (let i = 0; i < cumulativePnls.length; i++) {
    const value = cumulativePnls[i] ?? 0
    if (value > peak) {
      peak = value
      currentDdStart = i
    }
    const dd = peak - value
    if (dd > maxDd) {
      maxDd = dd
      maxDdDuration = i - currentDdStart
    }
  }

  return {
    maxDrawdownPct: maxDd,
    // Approximate: each trade represents ~8 hours = 28800 seconds
    maxDrawdownDurationSeconds: maxDdDuration * 28800,
  }
}

/**
 * Calculate profit factor = gross profits / gross losses.
 */
export function profitFactor(returns: number[]): number {
  let grossProfit = 0
  let grossLoss = 0
  for (const r of returns) {
    if (r > 0) grossProfit += r
    else if (r < 0) grossLoss += Math.abs(r)
  }
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0
  return grossProfit / grossLoss
}

/**
 * Calculate Calmar ratio = annualized return / max drawdown.
 */
export function calmarRatio(returns: number[], maxDd: number, periodsPerYear = 1095): number {
  if (maxDd === 0) return 0
  const totalReturn = returns.reduce((sum, r) => sum + r, 0)
  const annualizedReturn = (totalReturn / returns.length) * periodsPerYear
  return annualizedReturn / maxDd
}

/**
 * Calculate expectancy = (win_rate * avg_win) - (loss_rate * avg_loss)
 */
export function expectancy(returns: number[]): number {
  if (returns.length === 0) return 0
  const wins = returns.filter(r => r > 0)
  const losses = returns.filter(r => r < 0)
  const winRate = wins.length / returns.length
  const lossRate = losses.length / returns.length
  const avgWin = wins.length > 0 ? mean(wins) : 0
  const avgLoss = losses.length > 0 ? mean(losses.map(Math.abs)) : 0
  return winRate * avgWin - lossRate * avgLoss
}
