import type { InterpolationAnalysisResult, InterpolationRunExample, QuoteRow } from './types.js'

const LONG_RUN_THRESHOLD_SECONDS = 5 * 60
const LONG_RUN_EXAMPLE_LIMIT = 10

type InterpolationRunBucket = '1s' | '2-5s' | '5-30s' | '30s-5m' | '>5m'
type MutableRunBuckets = Record<InterpolationRunBucket, number>

function bucketForRunLength(lengthSeconds: number): InterpolationRunBucket {
  if (lengthSeconds === 1) {
    return '1s'
  }

  if (lengthSeconds <= 5) {
    return '2-5s'
  }

  if (lengthSeconds <= 30) {
    return '5-30s'
  }

  if (lengthSeconds <= LONG_RUN_THRESHOLD_SECONDS) {
    return '30s-5m'
  }

  return '>5m'
}

function pushLongRunExample(
  examples: InterpolationRunExample[],
  startTs: number,
  endTs: number,
  lengthSeconds: number
): void {
  if (examples.length >= LONG_RUN_EXAMPLE_LIMIT) {
    return
  }

  examples.push({ startTs, endTs, lengthSeconds })
}

export class InterpolationAnalysisAccumulator {
  private readonly runBuckets: MutableRunBuckets = {
    '1s': 0,
    '2-5s': 0,
    '5-30s': 0,
    '30s-5m': 0,
    '>5m': 0,
  }
  private readonly longRuns: InterpolationRunExample[] = []
  private rowCount = 0
  private interpolatedCount = 0
  private maxConsecutiveInterpolatedSeconds = 0
  private currentRunLength = 0
  private currentRunStartTs = 0
  private currentRunEndTs = 0

  private flushRun(): void {
    if (this.currentRunLength === 0) {
      return
    }

    const bucket = bucketForRunLength(this.currentRunLength)
    this.runBuckets[bucket] += 1
    this.maxConsecutiveInterpolatedSeconds = Math.max(this.maxConsecutiveInterpolatedSeconds, this.currentRunLength)

    if (this.currentRunLength > LONG_RUN_THRESHOLD_SECONDS) {
      pushLongRunExample(this.longRuns, this.currentRunStartTs, this.currentRunEndTs, this.currentRunLength)
    }

    this.currentRunLength = 0
    this.currentRunStartTs = 0
    this.currentRunEndTs = 0
  }

  update(row: QuoteRow): void {
    this.rowCount += 1

    if (!row.is_interpolated) {
      this.flushRun()
      return
    }

    this.interpolatedCount += 1
    if (this.currentRunLength === 0) {
      this.currentRunStartTs = row.ts
    }

    this.currentRunLength += 1
    this.currentRunEndTs = row.ts
  }

  finalize(): InterpolationAnalysisResult {
    this.flushRun()

    const interpolatedPercent = this.rowCount === 0 ? 0 : (this.interpolatedCount / this.rowCount) * 100

    return {
      interpolatedCount: this.interpolatedCount,
      interpolatedPercent,
      maxConsecutiveInterpolatedSeconds: this.maxConsecutiveInterpolatedSeconds,
      runBuckets: { ...this.runBuckets },
      longRuns: [...this.longRuns],
    }
  }
}

export function analyzeInterpolation(rows: QuoteRow[]): InterpolationAnalysisResult {
  const accumulator = new InterpolationAnalysisAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
