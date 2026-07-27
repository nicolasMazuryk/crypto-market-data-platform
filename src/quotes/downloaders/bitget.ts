import {
  DOWNLOAD_BACKOFF_BASE_MS,
  DOWNLOAD_BACKOFF_MAX_MS,
  DOWNLOAD_MAX_RETRIES,
  DOWNLOAD_TIMEOUT_MS,
} from '../config.js'
import { remoteFileExists } from './download.js'
import type { ExchangeDownloader, ListUrlsOptions } from './types.js'

/** Safety stop so a CDN glitch can't turn part enumeration into an endless scan. */
const BITGET_MAX_PARTS = 200

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

function partUrl(urlSymbol: string, compactDate: string, part: number): string {
  const paddedPart = String(part).padStart(3, '0')
  return `https://img.bitgetimg.com/online/trades/UMCBL/${urlSymbol}/${compactDate}_${paddedPart}.zip`
}

async function listDayPartUrls(urlSymbol: string, compactDate: string, options: ListUrlsOptions): Promise<string[]> {
  const urls: string[] = []

  for (let part = 1; part <= BITGET_MAX_PARTS; part += 1) {
    const url = partUrl(urlSymbol, compactDate, part)
    const exists = await remoteFileExists(url, {
      maxRetries: DOWNLOAD_MAX_RETRIES,
      backoffBaseMs: DOWNLOAD_BACKOFF_BASE_MS,
      backoffMaxMs: DOWNLOAD_BACKOFF_MAX_MS,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      ...(options.onInfo ? { onInfo: options.onInfo } : {}),
    })

    if (!exists) {
      return urls
    }

    urls.push(url)
  }

  options.onInfo?.(`Bitget part scan hit the cap of ${String(BITGET_MAX_PARTS)} parts for ${urlSymbol} ${compactDate}`)
  return urls
}

export const bitgetDownloader: ExchangeDownloader = {
  exchange: 'bitget',
  parserKey: 'bitget-trades',
  sourceType: 'trades',
  confidenceScore: 'low',

  toUrlSymbol(normalizedSymbol: string): string {
    return normalizedSymbol
  },

  // Bitget's trade archive files are on UTC+8 day boundaries, so a UTC day needs
  // day D and day D+1. Part counts vary per symbol-day, hence the probing in
  // `listUrls`; this synchronous form is only a single-part fallback.
  constructUrls(symbol: string, date: Date): string[] {
    const urlSymbol = this.toUrlSymbol(symbol)

    return [partUrl(urlSymbol, formatCompactDate(date), 1), partUrl(urlSymbol, formatCompactDate(addDays(date, 1)), 1)]
  },

  async listUrls(symbol: string, date: Date, options: ListUrlsOptions = {}): Promise<string[]> {
    const urlSymbol = this.toUrlSymbol(symbol)
    const firstDay = formatCompactDate(date)
    const secondDay = formatCompactDate(addDays(date, 1))

    // The two days are probed independently — an empty day D+1 is normal at the
    // edge of a symbol's listing.
    const firstDayUrls = await listDayPartUrls(urlSymbol, firstDay, options)
    const secondDayUrls = await listDayPartUrls(urlSymbol, secondDay, options)
    const urls = [...firstDayUrls, ...secondDayUrls]

    if (urls.length === 0) {
      throw new Error(`No bitget trade archive parts found for ${urlSymbol} ${firstDay}`)
    }

    return urls
  },
}
