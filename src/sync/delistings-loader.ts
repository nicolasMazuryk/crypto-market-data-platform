import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { DELISTINGS_DIR } from '../config/index.js'
import type { ExchangeSymbolResolver } from '../exchanges/symbol-resolver.js'
import type { ExchangeName, Market } from '../exchanges/types.js'
import { normalizeSymbol } from '../utils/symbol-normalizer.js'

function parseDelistingDate(value: string): Date | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const [datePart, timePart = '00:00'] = trimmed.split(/\s+/)
  const [yearRaw, monthRaw, dayRaw] = datePart.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  const [hourRaw = '0', minuteRaw = '0'] = timePart.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)

  if (!year || !month || !day) {
    return null
  }

  const timestamp = Date.UTC(year, month - 1, day, hour, minute)
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

export async function loadDelistingsForExchange(
  exchange: ExchangeName,
  resolver?: ExchangeSymbolResolver,
  delistingsDir: string = DELISTINGS_DIR
): Promise<Market[]> {
  const filePath = path.resolve(process.cwd(), delistingsDir, `${exchange}.json`)

  if (!existsSync(filePath)) {
    return []
  }

  const content = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(content)

  if (!parsed || typeof parsed !== 'object') {
    return []
  }

  const delistings = parsed as Record<string, string>

  return Object.entries(delistings).map(([symbol, dateValue]) => {
    const normalizedSymbol = normalizeSymbol(symbol)
    const delistingDate =
      typeof dateValue === 'string' ? parseDelistingDate(dateValue) : null

    return {
      exchange,
      symbol: normalizedSymbol,
      exchange_symbol: resolver
        ? resolver.getExchangeSymbol(normalizedSymbol, symbol)
        : symbol,
      type: 'perpetual',
      listing_date: null,
      delisting_date: delistingDate,
      is_active: false
    }
  })
}
