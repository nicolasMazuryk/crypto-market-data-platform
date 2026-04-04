import type { NegativeSpreadExample, QuoteRow, SpreadValidityResult } from './types.js'

const EXAMPLE_LIMIT = 20

type SpreadField = 'open' | 'high' | 'low' | 'close'

export class SpreadValidityAccumulator {
  private sourceType: string
  private totalNegativeSpreads = 0
  private readonly negativeSpreadCounts: Record<SpreadField, number> = {
    open: 0,
    high: 0,
    low: 0,
    close: 0,
  }
  private worstNegativeSpread: NegativeSpreadExample | null = null
  private readonly examples: NegativeSpreadExample[] = []

  constructor(sourceType = 'unknown') {
    this.sourceType = sourceType
  }

  update(row: QuoteRow): void {
    if (this.sourceType === 'unknown' && row.source_type) {
      this.sourceType = row.source_type
    }

    for (const field of ['open', 'close', 'high', 'low'] as const) {
      const bid = row[`bid_${field}`]
      const ask = row[`ask_${field}`]

      if (bid === null || ask === null) {
        continue
      }

      const spread = ask - bid
      if (spread >= 0) {
        continue
      }

      this.totalNegativeSpreads += 1
      this.negativeSpreadCounts[field] += 1

      const example: NegativeSpreadExample = {
        ts: row.ts,
        field,
        bid,
        ask,
        spread,
      }

      if (this.worstNegativeSpread === null || spread < this.worstNegativeSpread.spread) {
        this.worstNegativeSpread = example
      }

      if (this.examples.length < EXAMPLE_LIMIT) {
        this.examples.push(example)
      }
    }
  }

  finalize(): SpreadValidityResult {
    let status: SpreadValidityResult['status'] = 'pass'
    if (this.totalNegativeSpreads > 0) {
      status = this.sourceType === 'trades' ? 'warn' : 'fail'
    }

    return {
      sourceType: this.sourceType,
      totalNegativeSpreads: this.totalNegativeSpreads,
      negativeSpreadCounts: { ...this.negativeSpreadCounts },
      worstNegativeSpread: this.worstNegativeSpread,
      examples: [...this.examples],
      status,
    }
  }
}

export function validateSpreadValidity(rows: QuoteRow[], sourceType: string): SpreadValidityResult {
  const accumulator = new SpreadValidityAccumulator(sourceType)

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
