import { readZipLines } from '../extract/index.js'
import { BookState, type PriceLevel } from '../orderbook/index.js'
import type { QuoteParser } from '../types.js'
import { toFiniteNumber } from './csv.js'

interface BybitOrderbookMessage {
  readonly type?: string
  readonly ts?: number
  readonly data?: {
    readonly b?: unknown
    readonly a?: unknown
  }
}

function toPriceLevels(levels: unknown): PriceLevel[] {
  if (!Array.isArray(levels)) {
    return []
  }

  const parsed: PriceLevel[] = []

  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) {
      continue
    }

    const price = toFiniteNumber(String(level[0]))
    const size = toFiniteNumber(String(level[1]))
    if (price === null || size === null) {
      continue
    }

    parsed.push([price, size])
  }

  return parsed
}

export const bybitOrderbookParser: QuoteParser = {
  sourceType: 'orderbook',
  confidenceScore: 'high',

  async *parse(filePath: string) {
    const book = new BookState()

    for await (const line of readZipLines(filePath)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) {
        continue
      }

      let payload: BybitOrderbookMessage
      try {
        payload = JSON.parse(trimmed) as BybitOrderbookMessage
      } catch {
        continue
      }

      const timestampMs = payload.ts
      if (typeof timestampMs !== 'number') {
        continue
      }

      const bids = toPriceLevels(payload.data?.b)
      const asks = toPriceLevels(payload.data?.a)

      if (payload.type === 'snapshot') {
        book.applySnapshot(bids, asks)
      } else if (payload.type === 'delta') {
        book.applyDelta(bids, asks)
      } else {
        continue
      }

      yield {
        timestampMs,
        bid: book.getBestBid(),
        ask: book.getBestAsk(),
        sourceType: 'orderbook',
      }
    }
  },
}
