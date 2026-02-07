import { normalizeSymbol } from '../utils/symbol-normalizer.js'
import type { ExchangeName, Market } from './types.js'

interface SymbolFormat {
  prefix: string
  between: string
  suffix: string
}

const DEFAULT_QUOTE = 'USDT'

function inferSymbolFormat(normalizedSymbol: string, exchangeSymbol: string): SymbolFormat | null {
  const normalized = normalizeSymbol(normalizedSymbol)
  if (!normalized.endsWith(DEFAULT_QUOTE)) {
    return null
  }

  const base = normalized.slice(0, -DEFAULT_QUOTE.length)
  if (!base) {
    return null
  }

  const exchangeUpper = exchangeSymbol.toUpperCase()
  const baseIndex = exchangeUpper.indexOf(base)
  if (baseIndex === -1) {
    return null
  }

  const quoteIndex = exchangeUpper.indexOf(DEFAULT_QUOTE, baseIndex + base.length)
  if (quoteIndex === -1) {
    return null
  }

  return {
    prefix: exchangeSymbol.slice(0, baseIndex),
    between: exchangeSymbol.slice(baseIndex + base.length, quoteIndex),
    suffix: exchangeSymbol.slice(quoteIndex + DEFAULT_QUOTE.length),
  }
}

function applySymbolFormat(normalizedSymbol: string, format: SymbolFormat): string {
  if (!normalizedSymbol.endsWith(DEFAULT_QUOTE)) {
    return normalizedSymbol
  }

  const base = normalizedSymbol.slice(0, -DEFAULT_QUOTE.length)
  if (!base) {
    return normalizedSymbol
  }

  return `${format.prefix}${base}${format.between}${DEFAULT_QUOTE}${format.suffix}`
}

function selectMostCommonFormat(markets: Market[]): SymbolFormat | null {
  const counts = new Map<string, { format: SymbolFormat; count: number }>()

  for (const market of markets) {
    const format = inferSymbolFormat(market.symbol, market.exchange_symbol)
    if (!format) {
      continue
    }

    const key = `${format.prefix}|${format.between}|${format.suffix}`
    const existing = counts.get(key)

    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, { format, count: 1 })
    }
  }

  let selected: SymbolFormat | null = null
  let maxCount = 0

  for (const entry of counts.values()) {
    if (entry.count > maxCount) {
      maxCount = entry.count
      selected = entry.format
    }
  }

  return selected
}

export interface ExchangeSymbolResolver {
  exchange: ExchangeName
  getExchangeSymbol(normalizedSymbol: string, rawSymbol?: string): string
}

export function createExchangeSymbolResolver(exchange: ExchangeName, activeMarkets: Market[]): ExchangeSymbolResolver {
  const symbolMap = new Map<string, string>()

  for (const market of activeMarkets) {
    const normalized = normalizeSymbol(market.symbol)
    if (!symbolMap.has(normalized)) {
      symbolMap.set(normalized, market.exchange_symbol)
    }
  }

  const format = selectMostCommonFormat(activeMarkets)

  return {
    exchange,
    getExchangeSymbol(normalizedSymbol: string, rawSymbol?: string): string {
      const normalized = normalizeSymbol(normalizedSymbol)
      const mapped = symbolMap.get(normalized)
      if (mapped) {
        return mapped
      }

      if (format) {
        return applySymbolFormat(normalized, format)
      }

      return rawSymbol ?? normalized
    },
  }
}
