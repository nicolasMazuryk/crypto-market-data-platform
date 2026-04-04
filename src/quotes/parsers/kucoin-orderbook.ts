import { readZipLines } from '../extract/index.js'
import type { QuoteEvent, QuoteParser } from '../types.js'
import { toFiniteNumber } from './csv.js'

interface KucoinOrderbookRow {
  readonly bids?: unknown
  readonly asks?: unknown
  readonly timestamp?: number
  readonly ts?: number
}

function normalizeJsonColumn(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"')
  }

  return trimmed
}

function bestBid(levels: unknown): number | null {
  if (!Array.isArray(levels)) {
    return null
  }

  let best: number | null = null
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 1) {
      continue
    }

    const price = toFiniteNumber(String(level[0]))
    if (price === null) {
      continue
    }

    if (best === null || price > best) {
      best = price
    }
  }

  return best
}

function bestAsk(levels: unknown): number | null {
  if (!Array.isArray(levels)) {
    return null
  }

  let best: number | null = null
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 1) {
      continue
    }

    const price = toFiniteNumber(String(level[0]))
    if (price === null) {
      continue
    }

    if (best === null || price < best) {
      best = price
    }
  }

  return best
}

export const kucoinOrderbookParser: QuoteParser = {
  sourceType: 'orderbook',
  confidenceScore: 'high',

  async *parse(filePath: string) {
    let isHeader = true
    const events: QuoteEvent[] = []

    for await (const line of readZipLines(filePath)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) {
        continue
      }

      if (isHeader) {
        isHeader = false
        continue
      }

      let payload: KucoinOrderbookRow
      try {
        payload = JSON.parse(normalizeJsonColumn(trimmed)) as KucoinOrderbookRow
      } catch {
        continue
      }

      const timestampMs = payload.timestamp ?? payload.ts
      if (typeof timestampMs !== 'number') {
        continue
      }

      events.push({
        timestampMs,
        bid: bestBid(payload.bids),
        ask: bestAsk(payload.asks),
        sourceType: 'orderbook',
      })
    }

    events.sort((left, right) => left.timestampMs - right.timestampMs)

    for (const event of events) {
      yield event
    }
  },
}
