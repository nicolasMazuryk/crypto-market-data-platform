import { dayEndMs, dayStartMs, tsToDateString } from './day-utils.js'
import type { QuoteRow, TimestampAlignmentResult } from './types.js'

const ONE_SECOND_MS = 1000

function toSeconds(valueMs: number): number {
  return Math.round(valueMs / ONE_SECOND_MS)
}

export class TimestampAlignmentAccumulator {
  private firstTs: number | null = null
  private lastTs: number | null = null

  update(row: QuoteRow): void {
    if (this.firstTs === null) {
      this.firstTs = row.ts
    }

    this.lastTs = row.ts
  }

  finalize(): TimestampAlignmentResult {
    if (this.firstTs === null || this.lastTs === null) {
      return {
        firstTs: this.firstTs,
        lastTs: this.lastTs,
        firstOffsetSeconds: null,
        lastOffsetSeconds: null,
        pass: false,
      }
    }

    const firstDay = tsToDateString(this.firstTs)
    const lastDay = tsToDateString(this.lastTs)

    const firstOffsetSeconds = toSeconds(this.firstTs - dayStartMs(firstDay))
    const lastOffsetSeconds = toSeconds(dayEndMs(lastDay) - this.lastTs)

    return {
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      firstOffsetSeconds,
      lastOffsetSeconds,
      pass: firstOffsetSeconds === 0 && lastOffsetSeconds === 0,
    }
  }
}

export function validateTimestampAlignment(rows: QuoteRow[]): TimestampAlignmentResult {
  const accumulator = new TimestampAlignmentAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
