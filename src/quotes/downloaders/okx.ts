import type { ExchangeDownloader } from './types.js'

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function formatCompactDate(date: Date): string {
  return formatDate(date).replaceAll('-', '')
}

export const okxDownloader: ExchangeDownloader = {
  exchange: 'okx',
  parserKey: 'okx-orderbook',
  sourceType: 'orderbook',
  confidenceScore: 'high',

  toUrlSymbol(normalizedSymbol: string): string {
    if (normalizedSymbol.endsWith('USDT')) {
      const base = normalizedSymbol.slice(0, -4)
      return `${base}-USDT-SWAP`
    }

    return `${normalizedSymbol}-SWAP`
  },

  constructUrls(symbol: string, date: Date): string[] {
    const urlSymbol = this.toUrlSymbol(symbol)
    const compact = formatCompactDate(date)
    const ymd = formatDate(date)

    return [
      `https://static.okx.com/cdn/okx/match/orderbook/L2/400lv/daily/${compact}/${urlSymbol}-L2orderbook-400lv-${ymd}.tar.gz`,
    ]
  },
}
