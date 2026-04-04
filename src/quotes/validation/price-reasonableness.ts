import type {
  ExtremeTickExample,
  InvalidPriceExample,
  PriceField,
  PricePointStats,
  PriceReasonablenessResult,
  QuoteRow,
  ValidationStatus,
} from './types.js'
import { PRICE_FIELDS } from './types.js'

const EXAMPLE_LIMIT = 20
const EXTREME_TICK_THRESHOLD_PERCENT = 5

interface NumberAccumulator {
  min: number
  max: number
  sum: number
  count: number
}

function createAccumulator(): NumberAccumulator {
  return {
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    sum: 0,
    count: 0,
  }
}

function toStats(accumulator: NumberAccumulator): PricePointStats {
  if (accumulator.count === 0) {
    return {
      min: null,
      max: null,
      mean: null,
    }
  }

  return {
    min: accumulator.min,
    max: accumulator.max,
    mean: accumulator.sum / accumulator.count,
  }
}

function addInvalidPriceExample(examples: InvalidPriceExample[], ts: number, field: PriceField, value: number): void {
  if (examples.length >= EXAMPLE_LIMIT) {
    return
  }

  examples.push({
    ts,
    field,
    value: String(value),
  })
}

function addExtremeTickExample(
  examples: ExtremeTickExample[],
  field: 'bid_close' | 'ask_close',
  prevTs: number,
  ts: number,
  prevPrice: number,
  currPrice: number,
  changePercent: number
): void {
  if (examples.length >= EXAMPLE_LIMIT) {
    return
  }

  examples.push({
    field,
    prevTs,
    ts,
    prevPrice,
    currPrice,
    changePercent,
  })
}

function updateAccumulator(accumulator: NumberAccumulator, value: number | null): void {
  if (value === null || !Number.isFinite(value)) {
    return
  }

  accumulator.min = Math.min(accumulator.min, value)
  accumulator.max = Math.max(accumulator.max, value)
  accumulator.sum += value
  accumulator.count += 1
}

function deriveStatus(nanCount: number, infinityCount: number, extremeTickCount: number): ValidationStatus {
  if (nanCount > 0 || infinityCount > 0) {
    return 'fail'
  }

  if (extremeTickCount > 0) {
    return 'warn'
  }

  return 'pass'
}

export class PriceReasonablenessAccumulator {
  private readonly bidCloseAccumulator = createAccumulator()
  private readonly askCloseAccumulator = createAccumulator()
  private nanCount = 0
  private infinityCount = 0
  private readonly invalidPriceExamples: InvalidPriceExample[] = []
  private extremeTickCount = 0
  private readonly extremeTickExamples: ExtremeTickExample[] = []
  private prevBidClose: number | null = null
  private prevBidTs: number | null = null
  private prevAskClose: number | null = null
  private prevAskTs: number | null = null

  update(row: QuoteRow): void {
    updateAccumulator(this.bidCloseAccumulator, row.bid_close)
    updateAccumulator(this.askCloseAccumulator, row.ask_close)

    for (const field of PRICE_FIELDS) {
      const value = row[field]
      if (value === null) {
        continue
      }

      if (Number.isNaN(value)) {
        this.nanCount += 1
        addInvalidPriceExample(this.invalidPriceExamples, row.ts, field, value)
        continue
      }

      if (!Number.isFinite(value)) {
        this.infinityCount += 1
        addInvalidPriceExample(this.invalidPriceExamples, row.ts, field, value)
      }
    }

    if (row.is_interpolated) {
      return
    }

    const bidClose = row.bid_close
    if (bidClose !== null && Number.isFinite(bidClose)) {
      if (this.prevBidClose !== null && this.prevBidTs !== null && this.prevBidClose !== 0) {
        const changePercent = Math.abs(((bidClose - this.prevBidClose) / this.prevBidClose) * 100)
        if (changePercent > EXTREME_TICK_THRESHOLD_PERCENT) {
          this.extremeTickCount += 1
          addExtremeTickExample(
            this.extremeTickExamples,
            'bid_close',
            this.prevBidTs,
            row.ts,
            this.prevBidClose,
            bidClose,
            changePercent
          )
        }
      }

      this.prevBidClose = bidClose
      this.prevBidTs = row.ts
    }

    const askClose = row.ask_close
    if (askClose !== null && Number.isFinite(askClose)) {
      if (this.prevAskClose !== null && this.prevAskTs !== null && this.prevAskClose !== 0) {
        const changePercent = Math.abs(((askClose - this.prevAskClose) / this.prevAskClose) * 100)
        if (changePercent > EXTREME_TICK_THRESHOLD_PERCENT) {
          this.extremeTickCount += 1
          addExtremeTickExample(
            this.extremeTickExamples,
            'ask_close',
            this.prevAskTs,
            row.ts,
            this.prevAskClose,
            askClose,
            changePercent
          )
        }
      }

      this.prevAskClose = askClose
      this.prevAskTs = row.ts
    }
  }

  finalize(): PriceReasonablenessResult {
    return {
      nanCount: this.nanCount,
      infinityCount: this.infinityCount,
      invalidPriceExamples: [...this.invalidPriceExamples],
      extremeTickCount: this.extremeTickCount,
      extremeTickExamples: [...this.extremeTickExamples],
      bidCloseStats: toStats(this.bidCloseAccumulator),
      askCloseStats: toStats(this.askCloseAccumulator),
      status: deriveStatus(this.nanCount, this.infinityCount, this.extremeTickCount),
    }
  }
}

export function validatePriceReasonableness(rows: QuoteRow[]): PriceReasonablenessResult {
  const accumulator = new PriceReasonablenessAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
