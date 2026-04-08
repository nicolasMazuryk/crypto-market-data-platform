import type { ExchangeDownloader } from './types.js'

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export const bybitDownloader: ExchangeDownloader = {
  exchange: 'bybit',
  parserKey: 'bybit-orderbook',
  sourceType: 'orderbook',
  confidenceScore: 'high',

  toUrlSymbol(normalizedSymbol: string): string {
    return normalizedSymbol
  },

  constructUrls(symbol: string, date: Date): string[] {
    const urlSymbol = this.toUrlSymbol(symbol)
    const ymd = formatDate(date)

    return [`https://quote-saver.bycsi.com/orderbook/linear/${urlSymbol}/${ymd}_${urlSymbol}_ob200.data.zip`]
  },
}
