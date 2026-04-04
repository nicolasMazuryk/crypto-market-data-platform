import { dayStartMs, tsToDateString } from './day-utils.js'
import type { DayBoundaryContinuityResult, DayBoundaryGap, QuoteRow } from './types.js'

const ONE_SECOND_MS = 1000
const PRICE_JUMP_THRESHOLD_PERCENT = 0.25
const EXAMPLE_LIMIT = 20

function toMidPrice(row: QuoteRow): number | null {
  if (row.bid_close === null || row.ask_close === null) {
    return null
  }

  if (!Number.isFinite(row.bid_close) || !Number.isFinite(row.ask_close)) {
    return null
  }

  return (row.bid_close + row.ask_close) / 2
}

function pushExample(examples: DayBoundaryGap[], example: DayBoundaryGap): void {
  if (examples.length >= EXAMPLE_LIMIT) {
    return
  }

  examples.push(example)
}

export class DayBoundaryContinuityAccumulator {
  private dayCount = 0
  private checkedBoundaryCount = 0
  private gapAtBoundaryCount = 0
  private midnightMissingCount = 0
  private priceJumpCount = 0
  private readonly examples: DayBoundaryGap[] = []
  private currentDay: string | null = null
  private currentDayLastRow: QuoteRow | null = null

  update(row: QuoteRow): void {
    const day = tsToDateString(row.ts)

    if (this.currentDay === null) {
      this.currentDay = day
      this.currentDayLastRow = row
      this.dayCount = 1
      return
    }

    if (day === this.currentDay) {
      this.currentDayLastRow = row
      return
    }

    const previousDay = this.currentDay
    const previousLast = this.currentDayLastRow

    if (previousLast) {
      this.checkedBoundaryCount += 1

      const deltaMs = row.ts - previousLast.ts
      const gapDetected = deltaMs !== ONE_SECOND_MS
      if (gapDetected) {
        this.gapAtBoundaryCount += 1
      }

      const midnightMissing = row.ts !== dayStartMs(day)
      if (midnightMissing) {
        this.midnightMissingCount += 1
      }

      const previousMid = toMidPrice(previousLast)
      const currentMid = toMidPrice(row)
      let priceJumpPercent: number | null = null

      if (previousMid !== null && currentMid !== null && previousMid !== 0) {
        priceJumpPercent = Math.abs(((currentMid - previousMid) / previousMid) * 100)
        if (priceJumpPercent > PRICE_JUMP_THRESHOLD_PERCENT) {
          this.priceJumpCount += 1
        }
      }

      if (
        gapDetected ||
        midnightMissing ||
        (priceJumpPercent !== null && priceJumpPercent > PRICE_JUMP_THRESHOLD_PERCENT)
      ) {
        pushExample(this.examples, {
          previousDay,
          nextDay: day,
          previousTs: previousLast.ts,
          nextTs: row.ts,
          deltaMs,
          missingSeconds: deltaMs > ONE_SECOND_MS ? Math.floor(deltaMs / ONE_SECOND_MS) - 1 : 0,
          priceJumpPercent,
          midnightMissing,
        })
      }
    }

    this.currentDay = day
    this.currentDayLastRow = row
    this.dayCount += 1
  }

  finalize(): DayBoundaryContinuityResult {
    return {
      dayCount: this.dayCount,
      checkedBoundaryCount: this.checkedBoundaryCount,
      gapAtBoundaryCount: this.gapAtBoundaryCount,
      midnightMissingCount: this.midnightMissingCount,
      priceJumpCount: this.priceJumpCount,
      examples: [...this.examples],
      pass: this.gapAtBoundaryCount === 0 && this.midnightMissingCount === 0 && this.priceJumpCount === 0,
    }
  }
}

export function validateDayBoundaryContinuity(rows: QuoteRow[]): DayBoundaryContinuityResult {
  const accumulator = new DayBoundaryContinuityAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
