import type { QuoteRow, TimeContinuityResult, TimeGapExample } from './types.js'

const EXAMPLE_LIMIT = 20
const ONE_SECOND_MS = 1000

function addGapExample(
  examples: TimeGapExample[],
  prevTs: number,
  currTs: number,
  deltaMs: number,
  missingSeconds: number
): void {
  if (examples.length >= EXAMPLE_LIMIT) {
    return
  }

  examples.push({
    prevTs,
    currTs,
    deltaMs,
    missingSeconds,
  })
}

export class TimeContinuityAccumulator {
  private firstTs: number | null = null
  private lastTs: number | null = null
  private prevTs: number | null = null
  private actualCandles = 0

  private gapCount = 0
  private duplicateCount = 0
  private irregularStepCount = 0
  private nonMonotonicCount = 0
  private missingSeconds = 0
  private readonly gapExamples: TimeGapExample[] = []

  update(row: QuoteRow): void {
    if (this.firstTs === null) {
      this.firstTs = row.ts
    }

    this.lastTs = row.ts
    this.actualCandles += 1

    if (this.prevTs === null) {
      this.prevTs = row.ts
      return
    }

    const deltaMs = row.ts - this.prevTs
    if (deltaMs === ONE_SECOND_MS) {
      this.prevTs = row.ts
      return
    }

    if (deltaMs === 0) {
      this.duplicateCount += 1
      addGapExample(this.gapExamples, this.prevTs, row.ts, deltaMs, 0)
      this.prevTs = row.ts
      return
    }

    if (deltaMs < 0) {
      this.nonMonotonicCount += 1
      addGapExample(this.gapExamples, this.prevTs, row.ts, deltaMs, 0)
      this.prevTs = row.ts
      return
    }

    if (deltaMs > ONE_SECOND_MS) {
      this.gapCount += 1
      const gapMissingSeconds = Math.floor(deltaMs / ONE_SECOND_MS) - 1
      if (gapMissingSeconds > 0) {
        this.missingSeconds += gapMissingSeconds
      }

      addGapExample(this.gapExamples, this.prevTs, row.ts, deltaMs, Math.max(0, gapMissingSeconds))
      this.prevTs = row.ts
      return
    }

    this.irregularStepCount += 1
    addGapExample(this.gapExamples, this.prevTs, row.ts, deltaMs, 0)
    this.prevTs = row.ts
  }

  finalize(): TimeContinuityResult {
    if (this.actualCandles === 0) {
      return {
        firstTs: null,
        lastTs: null,
        durationMs: 0,
        expectedCandles: 0,
        actualCandles: 0,
        gapCount: 0,
        duplicateCount: 0,
        irregularStepCount: 0,
        nonMonotonicCount: 0,
        missingSeconds: 0,
        gapExamples: [],
        pass: false,
      }
    }

    const durationMs = this.firstTs !== null && this.lastTs !== null ? Math.max(0, this.lastTs - this.firstTs) : 0
    const expectedCandles =
      this.firstTs !== null && this.lastTs !== null ? Math.floor(durationMs / ONE_SECOND_MS) + 1 : this.actualCandles

    return {
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      durationMs,
      expectedCandles,
      actualCandles: this.actualCandles,
      gapCount: this.gapCount,
      duplicateCount: this.duplicateCount,
      irregularStepCount: this.irregularStepCount,
      nonMonotonicCount: this.nonMonotonicCount,
      missingSeconds: this.missingSeconds,
      gapExamples: [...this.gapExamples],
      pass:
        this.gapCount === 0 &&
        this.duplicateCount === 0 &&
        this.irregularStepCount === 0 &&
        this.nonMonotonicCount === 0,
    }
  }
}

export function validateTimeContinuity(rows: QuoteRow[]): TimeContinuityResult {
  const accumulator = new TimeContinuityAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
