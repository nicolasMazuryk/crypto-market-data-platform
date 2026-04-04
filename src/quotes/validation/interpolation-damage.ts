import type { InterpolationDamageResult, QuoteRow } from './types.js'

const HIGH_DAMAGE_THRESHOLD_PERCENT = 0.5

function toMidPrice(row: QuoteRow): number | null {
  if (row.bid_close === null || row.ask_close === null) {
    return null
  }

  if (!Number.isFinite(row.bid_close) || !Number.isFinite(row.ask_close)) {
    return null
  }

  return (row.bid_close + row.ask_close) / 2
}

export class InterpolationDamageAccumulator {
  private boundaryCount = 0
  private damageScore = 0
  private highDamageCount = 0
  private maxBoundaryChangePercent = 0
  private lastNonInterpolatedMid: number | null = null
  private inInterpolationRun = false
  private runStartMid: number | null = null

  update(row: QuoteRow): void {
    const midPrice = toMidPrice(row)

    if (row.is_interpolated) {
      if (!this.inInterpolationRun && this.lastNonInterpolatedMid !== null) {
        this.inInterpolationRun = true
        this.runStartMid = this.lastNonInterpolatedMid
      }

      return
    }

    if (this.inInterpolationRun && this.runStartMid !== null && midPrice !== null && this.runStartMid !== 0) {
      const changePercent = Math.abs(((midPrice - this.runStartMid) / this.runStartMid) * 100)
      this.boundaryCount += 1
      this.damageScore += changePercent
      this.maxBoundaryChangePercent = Math.max(this.maxBoundaryChangePercent, changePercent)

      if (changePercent > HIGH_DAMAGE_THRESHOLD_PERCENT) {
        this.highDamageCount += 1
      }
    }

    this.inInterpolationRun = false
    this.runStartMid = null

    if (midPrice !== null) {
      this.lastNonInterpolatedMid = midPrice
    }
  }

  finalize(): InterpolationDamageResult {
    return {
      boundaryCount: this.boundaryCount,
      damageScore: this.damageScore,
      highDamageCount: this.highDamageCount,
      maxBoundaryChangePercent: this.maxBoundaryChangePercent,
    }
  }
}

export function assessInterpolationDamage(rows: QuoteRow[]): InterpolationDamageResult {
  const accumulator = new InterpolationDamageAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
