import type { QuoteEvent } from '../types.js'

export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) {
    return line.split(',')
  }

  const values: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === undefined) {
      continue
    }

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      values.push(current)
      current = ''
      continue
    }

    current += char
  }

  values.push(current)
  return values
}

export function toFiniteNumber(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function unixSecondsToMs(value: string | null | undefined): number | null {
  const seconds = toFiniteNumber(value)
  if (seconds === null) {
    return null
  }

  return Math.round(seconds * 1000)
}

export function createTradeQuoteEvent(timestampMs: number, price: number, side: 'buy' | 'sell'): QuoteEvent {
  return {
    timestampMs,
    bid: side === 'sell' ? price : null,
    ask: side === 'buy' ? price : null,
    sourceType: 'trades',
  }
}
