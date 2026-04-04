import type { OhlcIntegrityResult, OhlcViolationExample, QuoteRow } from './types.js'

const EXAMPLE_LIMIT = 20

function pushExample(examples: OhlcViolationExample[], ts: number, side: 'bid' | 'ask', message: string): void {
  if (examples.length >= EXAMPLE_LIMIT) {
    return
  }

  examples.push({ ts, side, message })
}

function isNonNull(value: number | null): value is number {
  return value !== null
}

interface OhlcValues {
  open: number | null
  high: number | null
  low: number | null
  close: number | null
}

function readValues(row: QuoteRow, side: 'bid' | 'ask'): OhlcValues {
  if (side === 'bid') {
    return {
      open: row.bid_open,
      high: row.bid_high,
      low: row.bid_low,
      close: row.bid_close,
    }
  }

  return {
    open: row.ask_open,
    high: row.ask_high,
    low: row.ask_low,
    close: row.ask_close,
  }
}

export class OhlcIntegrityAccumulator {
  private partialOhlcCount = 0
  private negativePriceCount = 0
  private zeroPriceOnNonInterpolatedCount = 0
  private constraintViolationCount = 0
  private readonly examples: OhlcViolationExample[] = []

  update(row: QuoteRow): void {
    for (const side of ['bid', 'ask'] as const) {
      const { open, high, low, close } = readValues(row, side)
      const values = [open, high, low, close]
      const nonNullValues = values.filter(isNonNull)

      if (nonNullValues.length > 0 && nonNullValues.length < values.length) {
        this.partialOhlcCount += 1
        pushExample(this.examples, row.ts, side, 'partial OHLC detected (expected all O/H/L/C to be present)')
      }

      if (nonNullValues.length === 0) {
        continue
      }

      for (const value of nonNullValues) {
        if (value < 0) {
          this.negativePriceCount += 1
          pushExample(this.examples, row.ts, side, `negative price detected (${String(value)})`)
        }

        if (row.source_type === 'orderbook' && !row.is_interpolated && value === 0) {
          this.zeroPriceOnNonInterpolatedCount += 1
          pushExample(this.examples, row.ts, side, 'zero price on non-interpolated orderbook row')
        }
      }

      if (high !== null && open !== null && high < open) {
        this.constraintViolationCount += 1
        pushExample(this.examples, row.ts, side, `high < open (${String(high)} < ${String(open)})`)
      }

      if (high !== null && close !== null && high < close) {
        this.constraintViolationCount += 1
        pushExample(this.examples, row.ts, side, `high < close (${String(high)} < ${String(close)})`)
      }

      if (high !== null && low !== null && high < low) {
        this.constraintViolationCount += 1
        pushExample(this.examples, row.ts, side, `high < low (${String(high)} < ${String(low)})`)
      }

      if (low !== null && open !== null && low > open) {
        this.constraintViolationCount += 1
        pushExample(this.examples, row.ts, side, `low > open (${String(low)} > ${String(open)})`)
      }

      if (low !== null && close !== null && low > close) {
        this.constraintViolationCount += 1
        pushExample(this.examples, row.ts, side, `low > close (${String(low)} > ${String(close)})`)
      }
    }
  }

  finalize(): OhlcIntegrityResult {
    const violationCount =
      this.partialOhlcCount +
      this.negativePriceCount +
      this.zeroPriceOnNonInterpolatedCount +
      this.constraintViolationCount

    return {
      violationCount,
      partialOhlcCount: this.partialOhlcCount,
      negativePriceCount: this.negativePriceCount,
      zeroPriceOnNonInterpolatedCount: this.zeroPriceOnNonInterpolatedCount,
      constraintViolationCount: this.constraintViolationCount,
      examples: [...this.examples],
      pass: violationCount === 0,
    }
  }
}

export function validateOhlcIntegrity(rows: QuoteRow[]): OhlcIntegrityResult {
  const accumulator = new OhlcIntegrityAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
