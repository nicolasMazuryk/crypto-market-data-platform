import type { EquityCurveMetrics } from './types.js'

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function runningMax(equity: number[]): number[] {
  const result: number[] = []
  let peak = -Infinity
  for (const v of equity) {
    if (v > peak) peak = v
    result.push(peak)
  }
  return result
}

function olsRegression(y: number[]): { slope: number; intercept: number; slopeStdErr: number; ssRes: number } {
  const N = y.length
  const meanX = (N - 1) / 2
  const meanY = y.reduce((s, v) => s + v, 0) / N

  let Sxx = 0
  let Sxy = 0
  for (let i = 0; i < N; i++) {
    Sxx += (i - meanX) ** 2
    Sxy += (i - meanX) * ((y[i] ?? 0) - meanY)
  }

  const slope = Sxx === 0 ? 0 : Sxy / Sxx
  const intercept = meanY - slope * meanX

  let ssRes = 0
  for (let i = 0; i < N; i++) {
    ssRes += ((y[i] ?? 0) - (intercept + slope * i)) ** 2
  }

  const slopeStdErr = N <= 2 || Sxx === 0 ? 0 : Math.sqrt(ssRes / ((N - 2) * Sxx))

  return { slope, intercept, slopeStdErr, ssRes }
}

function scoreFinite(v: number): number {
  if (!isFinite(v)) return 100
  return v
}

export function computeEquityCurveMetrics(equity: number[]): EquityCurveMetrics | null {
  const N = equity.length

  if (N < 3) {
    console.warn('[equity-curve-metrics] equity array has fewer than 3 points — metrics skipped')
    return null
  }

  for (let i = 0; i < N; i++) {
    const v = equity[i]
    if (v === undefined || isNaN(v) || !isFinite(v)) {
      throw new Error(`[equity-curve-metrics] invalid value at index ${String(i)}: ${String(v)}`)
    }
  }

  // R² — OLS on log-equity
  const logEquity = equity.map(v => Math.log(Math.max(v, 1e-10)))
  const meanLog = logEquity.reduce((s, v) => s + v, 0) / N
  const { ssRes: ssResLog } = olsRegression(logEquity)
  let ssTot = 0
  for (const v of logEquity) ssTot += (v - meanLog) ** 2
  const r2 = ssTot === 0 ? 1 : 1 - ssResLog / ssTot

  // K-Ratio — OLS on raw equity
  const { slope, slopeStdErr } = olsRegression(equity)
  const kRatio =
    slopeStdErr === 0 ? (slope > 0 ? Infinity : slope < 0 ? -Infinity : 0) : slope / slopeStdErr / Math.sqrt(N)

  // Ulcer Index
  const peaks = runningMax(equity)
  let sumSqDd = 0
  for (let i = 0; i < N; i++) {
    const peak = peaks[i] ?? 0
    if (peak === 0) continue
    const ddPct = Math.min(0, (((equity[i] ?? 0) - peak) / peak) * 100)
    sumSqDd += ddPct ** 2
  }
  const ulcerIndex = Math.sqrt(sumSqDd / N)

  // Recovery Factor
  let maxAbsDd = 0
  for (let i = 0; i < N; i++) {
    const absDd = (peaks[i] ?? 0) - (equity[i] ?? 0)
    if (absDd > maxAbsDd) maxAbsDd = absDd
  }
  const totalPnl = (equity[N - 1] ?? 0) - (equity[0] ?? 0)
  const recoveryFactor = maxAbsDd === 0 ? Infinity : totalPnl / maxAbsDd

  // Serenity Ratio
  const steps: number[] = []
  for (let i = 1; i < N; i++) steps.push((equity[i] ?? 0) - (equity[i - 1] ?? 0))
  const meanStep = steps.reduce((s, v) => s + v, 0) / steps.length
  const serenityRatio = ulcerIndex === 0 ? Infinity : meanStep / ulcerIndex

  // Gain-to-Pain Ratio
  let gains = 0
  let losses = 0
  for (const d of steps) {
    if (d > 0) gains += d
    else if (d < 0) losses += Math.abs(d)
  }
  const gainToPainRatio = losses === 0 ? Infinity : gains / losses

  // Per-metric scores
  const scoreR2 = clamp(((r2 - 0.7) / 0.3) * 100, 0, 100)
  const scoreKRatio = clamp((scoreFinite(kRatio) / 0.4) * 100, 0, 100)
  const scoreUlcer = clamp((1 - ulcerIndex / 15.0) * 100, 0, 100)
  const scoreRecovery = clamp((scoreFinite(recoveryFactor) / 15.0) * 100, 0, 100)
  const scoreSerenity = clamp((scoreFinite(serenityRatio) / 0.01) * 100, 0, 100)
  const scoreGpr = clamp(((scoreFinite(gainToPainRatio) - 0.5) / 2.0) * 100, 0, 100)

  const qualityScore =
    0.2 * scoreR2 + 0.2 * scoreKRatio + 0.2 * scoreUlcer + 0.15 * scoreRecovery + 0.15 * scoreSerenity + 0.1 * scoreGpr

  return {
    r2,
    k_ratio: kRatio,
    ulcer_index: ulcerIndex,
    recovery_factor: recoveryFactor,
    serenity_ratio: serenityRatio,
    gain_to_pain_ratio: gainToPainRatio,
    scores: {
      r2: scoreR2,
      k_ratio: scoreKRatio,
      ulcer_index: scoreUlcer,
      recovery_factor: scoreRecovery,
      serenity_ratio: scoreSerenity,
      gain_to_pain_ratio: scoreGpr,
    },
    equity_curve_quality_score: qualityScore,
  }
}
