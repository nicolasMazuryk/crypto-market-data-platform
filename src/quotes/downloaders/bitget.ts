import type { ExchangeDownloader } from './types.js'

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function formatCompactDate(date: Date): string {
  return formatDate(date).replaceAll('-', '')
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

export const bitgetDownloader: ExchangeDownloader = {
  exchange: 'bitget',
  parserKey: 'bitget-orderbook',
  sourceType: 'orderbook',
  confidenceScore: 'high',

  toUrlSymbol(normalizedSymbol: string): string {
    return normalizedSymbol
  },

  constructUrls(symbol: string, date: Date): string[] {
    const urlSymbol = this.toUrlSymbol(symbol)
    const firstDay = formatCompactDate(date)
    const secondDay = formatCompactDate(addDays(date, 1))

    return [
      `https://img.bitgetimg.com/online/depth/${urlSymbol}/2/${firstDay}.zip`,
      `https://img.bitgetimg.com/online/depth/${urlSymbol}/2/${secondDay}.zip`,
    ]
  },
}
