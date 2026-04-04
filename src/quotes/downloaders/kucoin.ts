import type { ExchangeDownloader } from './types.js'

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export const kucoinDownloader: ExchangeDownloader = {
  exchange: 'kucoin',
  parserKey: 'kucoin-orderbook',
  sourceType: 'orderbook',
  confidenceScore: 'high',

  toUrlSymbol(normalizedSymbol: string): string {
    return normalizedSymbol.endsWith('M') ? normalizedSymbol : `${normalizedSymbol}M`
  },

  constructUrls(symbol: string, date: Date): string[] {
    const urlSymbol = this.toUrlSymbol(symbol)
    const ymd = formatDate(date)

    return [
      `https://historical-data.kucoin.com/data/futures/daily/depth/orderbooklv50/${urlSymbol}/${urlSymbol}-orderbooklv50-${ymd}.zip`,
    ]
  },
}
