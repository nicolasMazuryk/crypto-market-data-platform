import type { ExchangeDownloader } from './types.js'

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function formatCompactDate(date: Date): string {
  return formatDate(date).replaceAll('-', '')
}

export const gateioDownloader: ExchangeDownloader = {
  exchange: 'gateio',
  parserKey: 'gate-orderbook',
  sourceType: 'orderbook',
  confidenceScore: 'high',

  toUrlSymbol(normalizedSymbol: string): string {
    if (normalizedSymbol.endsWith('USDT')) {
      const base = normalizedSymbol.slice(0, -4)
      return `${base}_USDT`
    }

    return normalizedSymbol
  },

  constructUrls(symbol: string, date: Date): string[] {
    const urlSymbol = this.toUrlSymbol(symbol)
    const compact = formatCompactDate(date)
    const month = compact.slice(0, 6)

    const urls: string[] = []
    for (let hour = 0; hour < 24; hour += 1) {
      const hourToken = String(hour).padStart(2, '0')
      urls.push(
        `https://download.gatedata.org/futures_usdt/orderbooks/${month}/${urlSymbol}-${compact}${hourToken}.csv.gz`
      )
    }

    return urls
  },
}
