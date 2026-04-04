import type {
  CompletenessResult,
  DayBoundaryContinuityResult,
  InterpolationAnalysisResult,
  OhlcIntegrityResult,
  PriceReasonablenessResult,
  StalePriceResult,
  SpreadValidityResult,
  TimeContinuityResult,
} from './types.js'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export function computeCompleteness(
  actualCandles: number,
  expectedCandles: number,
  interpolation: InterpolationAnalysisResult,
  timeContinuity: TimeContinuityResult,
  ohlc: OhlcIntegrityResult,
  spread: SpreadValidityResult,
  price: PriceReasonablenessResult,
  dayBoundary: DayBoundaryContinuityResult,
  stalePrice: StalePriceResult
): CompletenessResult {
  const coveragePercent = expectedCandles === 0 ? 0 : (actualCandles / expectedCandles) * 100

  const interpolationDeduction = Math.min(30, interpolation.interpolatedPercent * 0.6)
  const gapDeduction = Math.min(
    35,
    timeContinuity.missingSeconds * 0.1 +
      timeContinuity.gapCount * 2 +
      timeContinuity.duplicateCount * 1 +
      timeContinuity.nonMonotonicCount * 3 +
      timeContinuity.irregularStepCount
  )
  const ohlcDeduction = Math.min(20, ohlc.violationCount * 0.25)
  const spreadDeduction = spread.status === 'fail' ? Math.min(10, spread.totalNegativeSpreads * 0.02) : 0
  const extremeTickDeduction = Math.min(10, price.extremeTickCount * 0.2)
  const dayBoundaryDeduction = Math.min(15, dayBoundary.gapAtBoundaryCount * 5)
  const stalePriceDeduction = Math.min(5, stalePrice.stalePercent * 0.1)

  const totalDeduction =
    interpolationDeduction +
    gapDeduction +
    ohlcDeduction +
    spreadDeduction +
    extremeTickDeduction +
    dayBoundaryDeduction +
    stalePriceDeduction
  const qualityScore = Math.round(clamp(100 - totalDeduction, 0, 100))

  return {
    expectedCandles,
    actualCandles,
    coveragePercent,
    qualityScore,
    deductions: {
      interpolation: interpolationDeduction,
      gaps: gapDeduction,
      ohlc: ohlcDeduction,
      spread: spreadDeduction,
      extremeTicks: extremeTickDeduction,
      dayBoundary: dayBoundaryDeduction,
      stalePrice: stalePriceDeduction,
    },
  }
}
