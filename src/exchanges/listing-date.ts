import type { ExchangeName } from './types.js'

const DEFAULT_LISTING_FIELDS = [
  'listingTime',
  'onboardDate',
  'listTime',
  'launchTime',
  'createdTime',
  'createTime',
  'openTime',
  'startTime',
  'firstOpenDate'
]

// Candidate field names observed in exchange `market.info` payloads (best-effort).
const EXCHANGE_LISTING_FIELDS: Record<ExchangeName, string[]> = {
  binance: ['onboardDate'],
  bybit: ['launchTime', 'createdTime', 'openTime'],
  okx: ['listTime'],
  mexc: ['listingTime', 'createTime', 'openTime'],
  bitget: ['listingTime', 'launchTime', 'openTime'],
  gateio: ['create_time', 'listing_time', 'open_time'],
  kucoin: ['firstOpenDate', 'createdAt', 'openTime']
}

function uniqueFields(fields: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const field of fields) {
    if (!seen.has(field)) {
      seen.add(field)
      result.push(field)
    }
  }
  return result
}

function getFieldValue(info: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = info
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined
    }
    const record = current as Record<string, unknown>
    if (!(segment in record)) {
      return undefined
    }
    current = record[segment]
  }
  return current
}

function toDateFromValue(value: unknown): Date | null {
  if (!value) {
    return null
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
  }

  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value
    if (ms <= 0) {
      return null
    }
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    const numeric = Number(trimmed)
    if (!Number.isNaN(numeric)) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric
      if (ms <= 0) {
        return null
      }
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? null : date
    }
    const parsed = new Date(trimmed)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  return null
}

export function extractListingDate(
  exchange: ExchangeName,
  info?: Record<string, unknown>
): Date | null {
  if (!info) {
    return null
  }

  const fields = uniqueFields([
    ...EXCHANGE_LISTING_FIELDS[exchange],
    ...DEFAULT_LISTING_FIELDS
  ])

  for (const field of fields) {
    const value = getFieldValue(info, field)
    const date = toDateFromValue(value)
    if (date) {
      return date
    }
  }

  return null
}
