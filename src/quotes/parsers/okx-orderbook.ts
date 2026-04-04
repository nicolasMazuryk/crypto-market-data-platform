import { readTarGzipLines } from '../extract/index.js'
import { BookState, type PriceLevel } from '../orderbook/index.js'
import type { QuoteParser } from '../types.js'
import { toFiniteNumber } from './csv.js'

interface OkxOrderbookMessage {
  readonly action?: string
  readonly ts?: string
  readonly bids?: unknown
  readonly asks?: unknown
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

export const okxOrderbookParser: QuoteParser = {
  sourceType: 'orderbook',
  confidenceScore: 'high',

  async *parse(filePath: string) {
    const book = new BookState()

    for await (const line of readTarGzipLines(filePath)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) {
        continue
      }

      let payload: OkxOrderbookMessage
      try {
        payload = JSON.parse(trimmed) as OkxOrderbookMessage
      } catch {
        continue
      }

      const timestampMs = toFiniteNumber(payload.ts)
      if (timestampMs === null) {
        continue
      }

      const bids = toPriceLevels(payload.bids)
      const asks = toPriceLevels(payload.asks)

      if (payload.action === 'snapshot') {
        book.applySnapshot(bids, asks)
      } else if (payload.action === 'update') {
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
