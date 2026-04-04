import type { QuoteRow, StalePriceResult, StaleRunExample } from './types.js'

const ONE_SECOND_MS = 1000
const EXAMPLE_LIMIT = 20

type StaleBucket = '1-10s' | '10-60s' | '1-5m' | '>5m'

type MutableBuckets = Record<StaleBucket, number>

function isValidPrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}

function bucketForRun(lengthSeconds: number): StaleBucket {
  if (lengthSeconds <= 10) {
    return '1-10s'
  }

  if (lengthSeconds <= 60) {
    return '10-60s'
  }

  if (lengthSeconds <= 5 * 60) {
    return '1-5m'
  }

  return '>5m'
}

function addExample(
  examples: StaleRunExample[],
  startTs: number,
  endTs: number,
  lengthSeconds: number,
  bidClose: number,
  askClose: number
): void {
  if (examples.length >= EXAMPLE_LIMIT) {
    return
  }

  examples.push({
    startTs,
    endTs,
    lengthSeconds,
    bidClose,
    askClose,
  })
}

export class StalePriceAccumulator {
  private readonly runBuckets: MutableBuckets = {
    '1-10s': 0,
    '10-60s': 0,
    '1-5m': 0,
    '>5m': 0,
  }
  private readonly examples: StaleRunExample[] = []
  private eligibleCount = 0
  private staleSeconds = 0
  private runCount = 0
  private longestRunSeconds = 0
  private previousTs: number | null = null
  private previousBid: number | null = null
  private previousAsk: number | null = null
  private runStartTs: number | null = null
  private runEndTs: number | null = null
  private runLengthSeconds = 0

  private flushRun(): void {
    if (
      this.runStartTs === null ||
      this.runEndTs === null ||
      this.previousBid === null ||
      this.previousAsk === null ||
      this.runLengthSeconds < 2
    ) {
      this.runStartTs = null
      this.runEndTs = null
      this.runLengthSeconds = 0
      return
    }

    this.runCount += 1
    this.staleSeconds += this.runLengthSeconds
    this.longestRunSeconds = Math.max(this.longestRunSeconds, this.runLengthSeconds)

    const bucket = bucketForRun(this.runLengthSeconds)
    this.runBuckets[bucket] += 1

    addExample(this.examples, this.runStartTs, this.runEndTs, this.runLengthSeconds, this.previousBid, this.previousAsk)

    this.runStartTs = null
    this.runEndTs = null
    this.runLengthSeconds = 0
  }

  update(row: QuoteRow): void {
    const bidClose = row.bid_close
    const askClose = row.ask_close

    if (row.is_interpolated || !isValidPrice(bidClose) || !isValidPrice(askClose)) {
      this.flushRun()
      this.previousTs = null
      this.previousBid = null
      this.previousAsk = null
      return
    }

    this.eligibleCount += 1

    if (
      this.previousTs !== null &&
      this.previousBid !== null &&
      this.previousAsk !== null &&
      row.ts - this.previousTs === ONE_SECOND_MS &&
      bidClose === this.previousBid &&
      askClose === this.previousAsk
    ) {
      if (this.runLengthSeconds === 0) {
        this.runStartTs = this.previousTs
        this.runEndTs = row.ts
        this.runLengthSeconds = 2
      } else {
        this.runEndTs = row.ts
        this.runLengthSeconds += 1
      }
    } else {
      this.flushRun()
    }

    this.previousTs = row.ts
    this.previousBid = bidClose
    this.previousAsk = askClose
  }

  finalize(): StalePriceResult {
    this.flushRun()

    let status: StalePriceResult['status'] = 'pass'
    if (this.longestRunSeconds > 5 * 60) {
      status = 'fail'
    } else if (this.longestRunSeconds > 60) {
      status = 'warn'
    }

    return {
      staleSeconds: this.staleSeconds,
      stalePercent: this.eligibleCount === 0 ? 0 : (this.staleSeconds / this.eligibleCount) * 100,
      runCount: this.runCount,
      longestRunSeconds: this.longestRunSeconds,
      runBuckets: { ...this.runBuckets },
      examples: [...this.examples],
      status,
    }
  }
}

export function detectStalePrice(rows: QuoteRow[]): StalePriceResult {
  const accumulator = new StalePriceAccumulator()

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
