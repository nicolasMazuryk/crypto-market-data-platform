import type { ExchangeDownloader } from './types.js'

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export const binanceDownloader: ExchangeDownloader = {
  exchange: 'binance',
  parserKey: 'binance-trades',
  sourceType: 'trades',
  confidenceScore: 'low',

  toUrlSymbol(normalizedSymbol: string): string {
    return normalizedSymbol
  },

  constructUrls(symbol: string, date: Date): string[] {
    const urlSymbol = this.toUrlSymbol(symbol)
    const ymd = formatDate(date)

    return [
      `https://data.binance.vision/data/futures/um/daily/aggTrades/${urlSymbol}/${urlSymbol}-aggTrades-${ymd}.zip`,
    ]
  },
}
