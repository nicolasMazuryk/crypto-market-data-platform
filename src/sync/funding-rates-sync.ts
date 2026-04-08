import ccxt from 'ccxt'
import unzipper from 'unzipper'

import {
  SYNC_DATA_PERIOD_END,
  SYNC_DATA_PERIOD_START,
  FUNDING_RATE_SYMBOL_CONCURRENCY,
  FUNDING_RATE_BACKOFF_BASE_MS,
  FUNDING_RATE_BACKOFF_MAX_MS,
  FUNDING_RATE_MAX_RETRIES,
  FUNDING_RATE_PAGE_SIZE,
  type FundingRateSyncMode,
} from '../config/index.js'
import { assertClickHouseHealthy } from '../db/health.js'
import {
  getLatestFundingRateTime,
  getOldestFundingRateTime,
  insertFundingRates,
  listFundingRateCompletenessGaps,
  listFundingRateTimesByExchangeSymbolRange,
  validateSymbolsForExchange,
} from '../db/queries/fundingRates.js'
import { listMarketsByExchange } from '../db/queries/markets.js'
import { toClickHouseDateTime, type FundingRateRow, type MarketRow } from '../db/types.js'
import { createCcxtExchange } from '../exchanges/ccxt-client.js'
import { EXCHANGE_CONFIGS } from '../exchanges/index.js'
import type { CcxtExchange, CcxtMarket, ExchangeConfig, ExchangeName } from '../exchanges/types.js'
import { logger } from '../logger.js'
import { normalizeSymbol } from '../utils/symbol-normalizer.js'

const DEFAULT_FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000
const MIN_FUNDING_INTERVAL_MS = 1 * 60 * 60 * 1000
const BINANCE_PUBLIC_DATA_BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/fundingRate'

interface FundingRateHistory {
  symbol?: string
  timestamp?: number
  fundingRate?: number
  info?: Record<string, unknown>
}

type FundingRateFetchMode = 'until' | 'beforeSince' | 'sinceUntilWindow' | 'page'

interface FundingRateFetchConfig {
  mode: FundingRateFetchMode
  maxLimit: number
  pageParam?: string
}

const FUNDING_RATE_FETCH_CONFIG: Record<ExchangeName, FundingRateFetchConfig> = {
  binance: { mode: 'until', maxLimit: 1000 },
  bybit: { mode: 'until', maxLimit: 200 },
  okx: { mode: 'beforeSince', maxLimit: 100 },
  mexc: { mode: 'page', maxLimit: 100, pageParam: 'page_num' },
  bitget: { mode: 'page', maxLimit: 100, pageParam: 'pageNo' },
  gateio: { mode: 'until', maxLimit: 1000 },
  kucoin: { mode: 'sinceUntilWindow', maxLimit: 100 },
}

interface BatchStats {
  fetched: number
  valid: number
  inserted: number
  skippedExisting: number
  skippedInvalid: number
}

interface MarketSyncStats {
  batches: number
  inserted: number
  skippedExisting: number
  skippedInvalid: number
  fetched: number
  resumedFromExisting: boolean
  completeToStart: boolean
  skipReason: 'none' | 'backfillRequired' | 'unsupportedMarket' | 'unresolvedSymbol'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Parses a ClickHouse DateTime string to a JavaScript Date object.
 *
 * IMPORTANT: ClickHouse DateTime type is timezone-agnostic and stores values as Unix timestamps.
 * By convention, all DateTimes in this application are treated as UTC. This function appends 'Z'
 * to ensure the resulting Date object is interpreted as UTC, not local time.
 *
 * @param value ClickHouse DateTime string (format: "YYYY-MM-DD HH:mm:ss" or ISO-8601)
 * @returns Date object in UTC, or null if parsing fails
 */
function parseClickHouseDateTime(value: string | null | undefined): Date | null {
  if (!value) {
    return null
  }

  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function toSecondTimestampMs(timestamp: number): number {
  return Math.floor(timestamp / 1000) * 1000
}

function getNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function readNumeric(info: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!info) {
    return null
  }

  for (const key of keys) {
    if (!(key in info)) {
      continue
    }

    const parsed = getNumber(info[key])
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

function inferFundingIntervalMs(market: CcxtMarket | undefined): number {
  if (!market) {
    return DEFAULT_FUNDING_INTERVAL_MS
  }

  const info = market.info
  const hours = readNumeric(info, ['fundingIntervalHours', 'funding_interval_hours', 'fundingRateIntervalHours'])
  if (hours && hours > 0) {
    return hours * 60 * 60 * 1000
  }

  const minutes = readNumeric(info, ['fundingInterval', 'funding_interval', 'fundingRateInterval'])
  if (minutes && minutes > 0) {
    return minutes * 60 * 1000
  }

  return DEFAULT_FUNDING_INTERVAL_MS
}

function formatDecimal(value: number, decimals = 8): string {
  const fixed = value.toFixed(decimals)
  return fixed === '-0.00000000' ? '0.00000000' : fixed
}

function extractMarkPrice(info?: Record<string, unknown>): string | null {
  const price = readNumeric(info, ['markPrice', 'mark_price', 'markPriceValue'])
  return price === null ? null : formatDecimal(price, 8)
}

function isRetryableError(error: unknown): boolean {
  if (!error) {
    return false
  }

  if (
    error instanceof ccxt.RateLimitExceeded ||
    error instanceof ccxt.DDoSProtection ||
    error instanceof ccxt.ExchangeNotAvailable ||
    error instanceof ccxt.RequestTimeout ||
    error instanceof ccxt.NetworkError
  ) {
    return true
  }

  if (error instanceof ccxt.BadRequest || error instanceof ccxt.AuthenticationError) {
    return false
  }

  const message = (error instanceof Error ? error.message : JSON.stringify(error)).toLowerCase()
  if (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('timeout') ||
    message.includes('temporarily unavailable')
  ) {
    return true
  }

  const status = (error as { status?: number }).status
  if (status && (status === 429 || status === 418 || status === 503)) {
    return true
  }

  return false
}

function isSkippableFundingRateError(exchange: ExchangeName, error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  // Bitget may return this for symbols that were recently removed.
  if (exchange === 'bitget' && (message.includes('"code":"40309"') || message.includes('symbol has been removed'))) {
    return true
  }

  // Gate occasionally rejects unavailable contracts through an auth-shaped error.
  if (exchange === 'gateio' && message.includes('missing required header: timestamp')) {
    return true
  }

  if (exchange === 'bybit' && message.includes('only support linear and inverse market')) {
    return true
  }

  return false
}

function createMarketSyncStats(): MarketSyncStats {
  return {
    batches: 0,
    inserted: 0,
    skippedExisting: 0,
    skippedInvalid: 0,
    fetched: 0,
    resumedFromExisting: false,
    completeToStart: false,
    skipReason: 'none',
  }
}

function monthStartUtc(timestampMs: number): number {
  const date = new Date(timestampMs)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0)
}

function nextMonthStartUtc(timestampMs: number): number {
  const date = new Date(timestampMs)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0)
}

function listMonthStarts(startMs: number, endMs: number): number[] {
  if (endMs <= startMs) {
    return []
  }

  const months: number[] = []
  let cursor = monthStartUtc(startMs)

  while (cursor < endMs) {
    months.push(cursor)
    cursor = nextMonthStartUtc(cursor)
  }

  return months
}

function buildBinanceFundingArchiveUrl(exchangeSymbol: string, monthStartMs: number): string {
  const date = new Date(monthStartMs)
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${BINANCE_PUBLIC_DATA_BASE_URL}/${exchangeSymbol}/${exchangeSymbol}-fundingRate-${year}-${month}.zip`
}

function parseBinanceFundingArchiveCsv(csvText: string, unifiedSymbol: string): FundingRateHistory[] {
  const lines = csvText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)

  if (lines.length <= 1) {
    return []
  }

  const rows: FundingRateHistory[] = []
  for (const line of lines.slice(1)) {
    const [calcTime, , lastFundingRate] = line.split(',')
    const timestamp = getNumber(calcTime)
    const fundingRate = getNumber(lastFundingRate)
    if (timestamp === null || fundingRate === null) {
      continue
    }

    rows.push({
      symbol: unifiedSymbol,
      timestamp,
      fundingRate,
      info: {},
    })
  }

  return rows
}

async function fetchBinanceFundingRateHistoryFromArchive(
  exchangeSymbol: string,
  unifiedSymbol: string,
  startMs: number,
  endMs: number
): Promise<FundingRateHistory[]> {
  const months = listMonthStarts(startMs, endMs)
  const rows: FundingRateHistory[] = []

  for (const monthStart of months) {
    const archiveUrl = buildBinanceFundingArchiveUrl(exchangeSymbol, monthStart)
    const response = await fetch(archiveUrl)

    if (response.status === 404) {
      continue
    }

    if (!response.ok) {
      throw new ccxt.ExchangeNotAvailable(`binance public archive ${archiveUrl} ${response.status} ${response.statusText}`)
    }

    const zipBuffer = Buffer.from(await response.arrayBuffer())
    const directory = await unzipper.Open.buffer(zipBuffer)
    const file = directory.files[0]
    if (!file) {
      continue
    }

    const csvText = (await file.buffer()).toString('utf8')
    rows.push(...parseBinanceFundingArchiveCsv(csvText, unifiedSymbol))
  }

  return rows.filter(row => {
    const timestamp = getNumber(row.timestamp)
    return timestamp !== null && timestamp >= startMs && timestamp < endMs
  })
}

function getLoadedMarket(exchange: CcxtExchange, unifiedSymbol: string): CcxtMarket | undefined {
  try {
    const boundMarket = exchange.market.bind(exchange)
    return boundMarket(unifiedSymbol)
  } catch {
    return exchange.markets?.[unifiedSymbol]
  }
}

function isFundingEligibleMarket(market: CcxtMarket | undefined): boolean {
  if (!market) {
    return false
  }

  return market.swap === true || market.future === true || market.contract === true || market.linear === true || market.inverse === true
}

async function withRetry<T>(
  action: () => Promise<T>,
  context: { exchange: string; symbol?: string; rateLimitMs?: number }
): Promise<T> {
  let attempt = 0
  const baseDelay =
    context.rateLimitMs !== undefined
      ? Math.max(FUNDING_RATE_BACKOFF_BASE_MS, context.rateLimitMs)
      : FUNDING_RATE_BACKOFF_BASE_MS

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    try {
      return await action()
    } catch (error) {
      if (!isRetryableError(error) || attempt >= FUNDING_RATE_MAX_RETRIES) {
        throw error
      }

      attempt += 1
      const delay = Math.min(FUNDING_RATE_BACKOFF_MAX_MS, baseDelay * 2 ** (attempt - 1))
      const jitter = Math.floor(delay * 0.2 * Math.random())
      const waitMs = delay + jitter

      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.warn(
        {
          exchange: context.exchange,
          symbol: context.symbol,
          attempt,
          waitMs,
          error: errorMessage,
        },
        'Funding rate request failed; backing off'
      )

      await sleep(waitMs)
    }
  }
}

type UnifiedSymbolResolver = (market: MarketRow) => string | null

function buildUnifiedSymbolResolver(exchange: CcxtExchange): UnifiedSymbolResolver {
  const DEFAULT_QUOTE = 'USDT'
  const normalizedSymbolToUnified = new Map<string, string>()
  const normalizedIdToUnified = new Map<string, string>()

  const choosePreferredSymbol = (current: string | undefined, candidate: CcxtMarket): string => {
    if (!current) {
      return candidate.symbol
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const markets = exchange.markets ?? {}
    const currentMarket = markets[current]
    const currentScore = (currentMarket?.swap ? 2 : 0) + (currentMarket?.linear ? 1 : 0)
    const candidateScore = (candidate.swap ? 2 : 0) + (candidate.linear ? 1 : 0)
    return candidateScore > currentScore ? candidate.symbol : current
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const knownMarkets = Object.values(exchange.markets ?? {})
  for (const candidate of knownMarkets) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!candidate?.symbol) {
      continue
    }

    const normalizedSymbol = normalizeSymbol(candidate.symbol)
    const preferredBySymbol = choosePreferredSymbol(normalizedSymbolToUnified.get(normalizedSymbol), candidate)
    normalizedSymbolToUnified.set(normalizedSymbol, preferredBySymbol)

    if (candidate.id) {
      const normalizedId = normalizeSymbol(candidate.id)
      const preferredById = choosePreferredSymbol(normalizedIdToUnified.get(normalizedId), candidate)
      normalizedIdToUnified.set(normalizedId, preferredById)
    }
  }

  return (market: MarketRow): string | null => {
    const candidates = [normalizeSymbol(market.symbol), normalizeSymbol(market.exchange_symbol)]

    for (const candidate of candidates) {
      if (!candidate) {
        continue
      }

      const bySymbol = normalizedSymbolToUnified.get(candidate)
      if (bySymbol) {
        return bySymbol
      }

      const byId = normalizedIdToUnified.get(candidate)
      if (byId) {
        return byId
      }
    }

    const fallback = normalizeSymbol(market.exchange_symbol) || normalizeSymbol(market.symbol)
    if (!fallback.endsWith(DEFAULT_QUOTE)) {
      return null
    }

    const base = fallback.slice(0, -DEFAULT_QUOTE.length)
    if (!base) {
      return null
    }

    return `${base}/USDT:${DEFAULT_QUOTE}`
  }
}

/**
 * Ensures a market exists in the CCXT exchange instance.
 *
 * DESIGN NOTE: This function mutates CCXT's internal state by adding synthetic markets
 * for delisted symbols. This is necessary because:
 * 1. CCXT's fetchFundingRateHistory() requires a valid symbol from exchange.markets
 * 2. Delisted markets are not returned by loadMarkets() but still have historical data
 * 3. CCXT's internal safeMarket/safeSymbol lookups require markets_by_id entries
 *
 * Alternative approaches considered:
 * - Creating separate exchange instances per symbol: Too expensive (rate limits, memory)
 * - Using raw exchange IDs: Breaks CCXT's symbol resolution and fetchFundingRateHistory
 * - Non-mutating wrapper: Would require reimplementing CCXT's complex market resolution logic
 *
 * This mutation is safe because:
 * - Only adds missing markets, never modifies existing ones
 * - Exchange instance is not shared across concurrent sync runs
 * - Synthetic markets contain only the minimal data needed for funding rate fetching
 *
 * @param exchange CCXT exchange instance (will be mutated if market is missing)
 * @param unifiedSymbol The CCXT unified symbol (e.g., 'BTC/USDT:USDT')
 * @param market The market row from our database
 * @returns The market object (either existing or newly created)
 */
function ensureMarketInExchange(
  exchange: CcxtExchange,
  unifiedSymbol: string,
  market: MarketRow
): CcxtMarket | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (exchange.markets) {
    const existing = exchange.markets[unifiedSymbol]
    if (existing) {
      return existing
    }
  }

  const normalizedExchangeSymbol = normalizeSymbol(market.exchange_symbol)
  const base = normalizedExchangeSymbol.endsWith('USDT')
    ? normalizedExchangeSymbol.slice(0, -'USDT'.length)
    : normalizeSymbol(unifiedSymbol).replace(/USDT$/, '')

  const synthetic: CcxtMarket = {
    id: market.exchange_symbol,
    symbol: unifiedSymbol,
    type: 'swap',
    contract: true,
    future: false,
    option: false,
    spot: false,
    swap: true,
    linear: true,
    base,
    baseId: base,
    quote: 'USDT',
    quoteId: 'USDT',
    settle: 'USDT',
    settleId: 'usdt',
    active: market.is_active,
    info: {},
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  exchange.markets ??= {}
  exchange.markets[unifiedSymbol] = synthetic

  // CCXT expects markets_by_id entries to be arrays.
  // Storing a plain object here can break safeMarket/safeSymbol resolution.
  exchange.markets_by_id ??= {}
  const byIdEntry = exchange.markets_by_id[market.exchange_symbol]
  if (Array.isArray(byIdEntry)) {
    // Keep only the swap market for funding-rate flows to avoid id ambiguity.
    const preferred = byIdEntry.find(entry => entry.swap === true || entry.linear === true) ?? byIdEntry[0]
    exchange.markets_by_id[market.exchange_symbol] = preferred ? [preferred] : [synthetic]
  } else if (byIdEntry) {
    exchange.markets_by_id[market.exchange_symbol] = [byIdEntry]
  } else {
    exchange.markets_by_id[market.exchange_symbol] = [synthetic]
  }

  return synthetic
}

function getEffectiveRange(market: MarketRow, now: Date): { start: Date; end: Date } | null {
  const listing = parseClickHouseDateTime(market.listing_date)
  const delisting = parseClickHouseDateTime(market.delisting_date)

  const start = listing && listing > SYNC_DATA_PERIOD_START ? listing : SYNC_DATA_PERIOD_START
  const periodEnd = SYNC_DATA_PERIOD_END ?? now
  const end = delisting && delisting < periodEnd ? delisting : periodEnd

  if (end <= start) {
    return null
  }

  return { start, end }
}

function getPageSize(fetchConfig: FundingRateFetchConfig): number {
  return Math.max(1, Math.min(fetchConfig.maxLimit, FUNDING_RATE_PAGE_SIZE))
}

function buildBackwardFetchRequest(
  fetchConfig: FundingRateFetchConfig,
  cursorEndMs: number,
  startMs: number,
  intervalMs: number
): {
  since: number | undefined
  limit: number | undefined
  params: Record<string, unknown>
} {
  const pageSize = getPageSize(fetchConfig)

  switch (fetchConfig.mode) {
    case 'until': {
      const limit = Math.max(1, fetchConfig.maxLimit)
      // Calculate a reasonable window to prevent fetching records that are too far back
      // This ensures we don't get records way earlier than expected when using 'until' mode
      const windowMs = limit * Math.min(intervalMs, MIN_FUNDING_INTERVAL_MS)
      const since = Math.max(startMs, cursorEndMs - windowMs)
      return {
        since,
        limit,
        params: { until: Math.max(cursorEndMs - 1, 0) },
      }
    }
    case 'beforeSince':
      return {
        since: undefined,
        limit: pageSize,
        params: { after: Math.max(cursorEndMs - 1, 0) },
      }
    case 'sinceUntilWindow': {
      const limit = Math.max(1, fetchConfig.maxLimit)
      const windowMs = limit * Math.min(intervalMs, MIN_FUNDING_INTERVAL_MS)
      const since = Math.max(startMs, cursorEndMs - windowMs)
      return {
        since,
        limit,
        params: { until: Math.max(cursorEndMs - 1, 0) },
      }
    }
    case 'page':
      return { since: undefined, limit: pageSize, params: {} }
  }
}

function extractBatchTimestamps(batch: FundingRateHistory[], market: MarketRow, unifiedSymbol: string): number[] {
  const normalizedTarget = normalizeSymbol(market.symbol)
  const timestamps: number[] = []

  for (const entry of batch) {
    const ts = getNumber(entry.timestamp)
    if (ts === null) {
      continue
    }

    const symbol = entry.symbol ?? unifiedSymbol
    if (symbol && normalizeSymbol(symbol) !== normalizedTarget) {
      continue
    }

    timestamps.push(toSecondTimestampMs(ts))
  }

  return timestamps
}

async function fetchFundingRateHistory(
  exchange: CcxtExchange,
  symbol: string,
  since: number | undefined,
  limit: number | undefined,
  params: Record<string, unknown>,
  context: { exchange: string; symbol: string }
): Promise<FundingRateHistory[]> {
  if (!exchange.fetchFundingRateHistory) {
    return []
  }

  const result = await withRetry(
    async () => {
      if (!exchange.fetchFundingRateHistory) {
        return []
      }
      const boundFetchHistory = exchange.fetchFundingRateHistory.bind(exchange)
      return boundFetchHistory(symbol, since, limit, params) as Promise<FundingRateHistory[]>
    },
    exchange.rateLimit === undefined
      ? {
          exchange: context.exchange,
          symbol: context.symbol,
        }
      : {
          exchange: context.exchange,
          symbol: context.symbol,
          rateLimitMs: exchange.rateLimit,
        }
  )

  return Array.isArray(result) ? result : []
}

async function processFundingRateBatch(
  exchange: string,
  market: MarketRow,
  unifiedSymbol: string,
  batch: FundingRateHistory[],
  startMs: number,
  endMs: number,
  now: Date
): Promise<BatchStats> {
  let skippedInvalid = 0
  let valid = 0
  const normalizedTarget = normalizeSymbol(market.symbol)
  const candidates = new Map<number, FundingRateRow>()

  for (const rate of batch) {
    const timestamp = getNumber(rate.timestamp)
    if (timestamp === null) {
      skippedInvalid += 1
      continue
    }

    const fundingRate = getNumber(rate.fundingRate)
    if (fundingRate === null) {
      skippedInvalid += 1
      continue
    }

    const symbol = rate.symbol ?? unifiedSymbol
    if (symbol && normalizeSymbol(symbol) !== normalizedTarget) {
      skippedInvalid += 1
      continue
    }

    const alignedTs = toSecondTimestampMs(timestamp)
    if (alignedTs < startMs || alignedTs >= endMs) {
      continue
    }

    valid += 1

    const row: FundingRateRow = {
      exchange,
      symbol: market.symbol,
      exchange_symbol: market.exchange_symbol,
      funding_time: toClickHouseDateTime(new Date(alignedTs)),
      funding_rate: formatDecimal(fundingRate, 8),
      mark_price: extractMarkPrice(rate.info),
      created_at: toClickHouseDateTime(now),
    }

    candidates.set(alignedTs, row)
  }

  if (candidates.size === 0) {
    return {
      fetched: batch.length,
      valid,
      inserted: 0,
      skippedExisting: 0,
      skippedInvalid,
    }
  }

  const timestamps = Array.from(candidates.keys())
  const minMs = Math.min(...timestamps)
  const maxMs = Math.max(...timestamps) + 1000
  const existingTimes = await listFundingRateTimesByExchangeSymbolRange(
    exchange,
    market.symbol,
    toClickHouseDateTime(new Date(minMs)),
    toClickHouseDateTime(new Date(maxMs))
  )

  const existingSet = new Set<number>()
  for (const value of existingTimes) {
    const parsed = parseClickHouseDateTime(value)
    if (parsed) {
      existingSet.add(parsed.getTime())
    }
  }

  const rows: FundingRateRow[] = []
  let skippedExisting = 0
  for (const [ts, row] of candidates) {
    if (existingSet.has(ts)) {
      skippedExisting += 1
      continue
    }

    rows.push(row)
  }

  await insertFundingRates(rows)

  return {
    fetched: batch.length,
    valid,
    inserted: rows.length,
    skippedExisting,
    skippedInvalid,
  }
}

async function syncMarketFundingRates(
  exchangeConfig: ExchangeConfig,
  exchange: CcxtExchange,
  market: MarketRow,
  resolveSymbol: UnifiedSymbolResolver,
  now: Date,
  syncMode: FundingRateSyncMode
): Promise<MarketSyncStats> {
  const stats = createMarketSyncStats()

  const unifiedSymbol = resolveSymbol(market)
  if (!unifiedSymbol) {
    stats.skipReason = 'unresolvedSymbol'
    logger.warn(
      {
        exchange: exchangeConfig.name,
        symbol: market.symbol,
        exchange_symbol: market.exchange_symbol,
      },
      'Unable to resolve unified symbol for funding rates'
    )
    return stats
  }

  const range = getEffectiveRange(market, now)
  if (!range) {
    stats.completeToStart = true
    return stats
  }

  let startMs = range.start.getTime()
  let cursorEndMs = range.end.getTime()

  let loadedMarket = getLoadedMarket(exchange, unifiedSymbol)
  if (loadedMarket && !isFundingEligibleMarket(loadedMarket)) {
    stats.skipReason = 'unsupportedMarket'
    logger.info(
      {
        exchange: exchangeConfig.name,
        symbol: market.symbol,
        exchange_symbol: market.exchange_symbol,
      },
      'Skipping funding rate sync for unsupported market'
    )
    return stats
  }

  if (syncMode === 'incremental') {
    const latestStored = await getLatestFundingRateTime(exchangeConfig.name, market.symbol)
    const latestStoredDate = parseClickHouseDateTime(latestStored)
    if (!latestStoredDate || latestStoredDate.getTime() < startMs) {
      stats.skipReason = 'backfillRequired'
      logger.info(
        {
          exchange: exchangeConfig.name,
          symbol: market.symbol,
          latestStored,
        },
        'Skipping funding rate sync until backfill seeds the historical window'
      )
      return stats
    }

    startMs = Math.max(startMs, latestStoredDate.getTime() + 1000)
    stats.resumedFromExisting = true

    if (!loadedMarket) {
      loadedMarket = ensureMarketInExchange(exchange, unifiedSymbol, market)
    }
  } else {
    if (!loadedMarket) {
      loadedMarket = ensureMarketInExchange(exchange, unifiedSymbol, market)
    }

    const oldestStored = await getOldestFundingRateTime(exchangeConfig.name, market.symbol)
    const oldestStoredDate = parseClickHouseDateTime(oldestStored)
    if (oldestStoredDate) {
      const oldestStoredMs = oldestStoredDate.getTime()
      if (oldestStoredMs > startMs && oldestStoredMs < cursorEndMs) {
        cursorEndMs = oldestStoredMs
        stats.resumedFromExisting = true
      }
    }
  }

  if (cursorEndMs <= startMs) {
    stats.completeToStart = true
    return stats
  }

  const fetchConfig = FUNDING_RATE_FETCH_CONFIG[exchangeConfig.name]
  const marketInfo = loadedMarket ?? getLoadedMarket(exchange, unifiedSymbol)
  const intervalMs = inferFundingIntervalMs(marketInfo)

  if (exchangeConfig.name === 'binance') {
    const batch = await fetchBinanceFundingRateHistoryFromArchive(market.exchange_symbol, unifiedSymbol, startMs, cursorEndMs)
    if (batch.length === 0) {
      if (syncMode === 'backfill') {
        stats.completeToStart = true
      }

      return stats
    }

    stats.batches = 1
    stats.fetched = batch.length

    const batchStats = await processFundingRateBatch(
      exchangeConfig.name,
      market,
      unifiedSymbol,
      batch,
      startMs,
      cursorEndMs,
      now
    )

    stats.inserted = batchStats.inserted
    stats.skippedExisting = batchStats.skippedExisting
    stats.skippedInvalid = batchStats.skippedInvalid

    const timestamps = extractBatchTimestamps(batch, market, unifiedSymbol)
    if (syncMode === 'backfill' && timestamps.length > 0 && Math.min(...timestamps) <= startMs) {
      stats.completeToStart = true
    }

    return stats
  }

  if (fetchConfig.mode === 'page') {
    const pageSize = getPageSize(fetchConfig)
    const upperBoundMs = cursorEndMs
    let page = 1
    let lastOldest = Number.POSITIVE_INFINITY
    const maxPages = 10000 // Safety limit to prevent infinite loops

    while (page <= maxPages) {
      const params: Record<string, unknown> = {}
      if (fetchConfig.pageParam) {
        params[fetchConfig.pageParam] = page
      }

      const batch = await fetchFundingRateHistory(exchange, unifiedSymbol, undefined, pageSize, params, {
        exchange: exchangeConfig.name,
        symbol: market.symbol,
      })

      if (batch.length === 0) {
        break
      }

      stats.batches += 1
      stats.fetched += batch.length

      const batchStats = await processFundingRateBatch(
        exchangeConfig.name,
        market,
        unifiedSymbol,
        batch,
        startMs,
        upperBoundMs,
        now
      )

      stats.inserted += batchStats.inserted
      stats.skippedExisting += batchStats.skippedExisting
      stats.skippedInvalid += batchStats.skippedInvalid

      const timestamps = extractBatchTimestamps(batch, market, unifiedSymbol)
      if (timestamps.length === 0) {
        break
      }

      const oldest = Math.min(...timestamps)
      if (oldest <= startMs) {
        break
      }

      if (oldest >= lastOldest) {
        logger.warn(
          { exchange: exchangeConfig.name, symbol: market.symbol, page },
          'Funding rate pagination stalled; stopping'
        )
        break
      }

      lastOldest = oldest
      page += 1
    }

    if (lastOldest <= startMs) {
      stats.completeToStart = true
    }

    return stats
  }

  while (cursorEndMs > startMs) {
    const request = buildBackwardFetchRequest(fetchConfig, cursorEndMs, startMs, intervalMs)

    const batch = await fetchFundingRateHistory(exchange, unifiedSymbol, request.since, request.limit, request.params, {
      exchange: exchangeConfig.name,
      symbol: market.symbol,
    })

    if (batch.length === 0) {
      break
    }

    stats.batches += 1
    stats.fetched += batch.length

    const batchStats = await processFundingRateBatch(
      exchangeConfig.name,
      market,
      unifiedSymbol,
      batch,
      startMs,
      cursorEndMs,
      now
    )

    stats.inserted += batchStats.inserted
    stats.skippedExisting += batchStats.skippedExisting
    stats.skippedInvalid += batchStats.skippedInvalid

    const timestamps = extractBatchTimestamps(batch, market, unifiedSymbol)
    if (timestamps.length === 0) {
      break
    }

    const oldest = Math.min(...timestamps)
    if (oldest <= startMs) {
      stats.completeToStart = true
      break
    }

    if (oldest >= cursorEndMs) {
      logger.warn(
        { exchange: exchangeConfig.name, symbol: market.symbol, cursorEndMs, oldest },
        'Funding rate backward cursor stalled; stopping'
      )
      break
    }

    cursorEndMs = oldest
  }

  if (cursorEndMs <= startMs) {
    stats.completeToStart = true
  }

  return stats
}

async function syncExchangeFundingRates(exchangeConfig: ExchangeConfig, syncMode: FundingRateSyncMode): Promise<void> {
  const exchange = createCcxtExchange(exchangeConfig)
  const hasFundingHistory = exchange.has?.fetchFundingRateHistory !== false && !!exchange.fetchFundingRateHistory

  if (!hasFundingHistory) {
    logger.warn({ exchange: exchangeConfig.name }, 'Exchange does not support funding rate history')
    return
  }

  const loadMarketsMethod = exchange.loadMarkets.bind(exchange)
  await loadMarketsMethod()
  const resolveSymbol = buildUnifiedSymbolResolver(exchange)
  const allMarkets = await listMarketsByExchange(exchangeConfig.name, true)
  const now = new Date()

  // Filter markets based on listing_date and delisting_date relative to data period
  // Exclude markets that:
  // - Have listing_date after SYNC_DATA_PERIOD_END (not listed during the period)
  // - Have delisting_date before SYNC_DATA_PERIOD_START (delisted before period)
  const periodEnd = SYNC_DATA_PERIOD_END ?? now
  const markets = allMarkets.filter(market => {
    if (market.type !== 'perpetual') {
      return false
    }

    const listingDate = parseClickHouseDateTime(market.listing_date)
    const delistingDate = parseClickHouseDateTime(market.delisting_date)

    // Exclude if listed after period end
    if (listingDate && listingDate > periodEnd) {
      return false
    }

    // Exclude if delisted before period start
    if (delistingDate && delistingDate < SYNC_DATA_PERIOD_START) {
      return false
    }

    return true
  })

  const marketStats: MarketSyncStats[] = []

  await runWithConcurrency(markets, FUNDING_RATE_SYMBOL_CONCURRENCY, async market => {
    try {
      const stats = await syncMarketFundingRates(exchangeConfig, exchange, market, resolveSymbol, now, syncMode)

      marketStats.push(stats)

      logger.info(
        {
          exchange: exchangeConfig.name,
          symbol: market.symbol,
          fetched: stats.fetched,
          inserted: stats.inserted,
          skippedExisting: stats.skippedExisting,
          skippedInvalid: stats.skippedInvalid,
          batches: stats.batches,
          resumedFromExisting: stats.resumedFromExisting,
          completeToStart: stats.completeToStart,
          skipReason: stats.skipReason,
        },
        'Funding rate sync complete for symbol'
      )
    } catch (error) {
      if (isSkippableFundingRateError(exchangeConfig.name, error)) {
        const stats = createMarketSyncStats()
        stats.skipReason = 'unsupportedMarket'
        marketStats.push(stats)
        logger.info(
          {
            err: error,
            exchange: exchangeConfig.name,
            symbol: market.symbol,
          },
          'Funding rate sync skipped for unavailable market'
        )
      } else {
        logger.warn(
          {
            err: error,
            exchange: exchangeConfig.name,
            symbol: market.symbol,
          },
          'Funding rate sync failed for market'
        )
      }
    }
  })

  const totalInserted = marketStats.reduce((sum, value) => sum + value.inserted, 0)
  const totalSkippedExisting = marketStats.reduce((sum, value) => sum + value.skippedExisting, 0)
  const totalSkippedInvalid = marketStats.reduce((sum, value) => sum + value.skippedInvalid, 0)
  const totalFetched = marketStats.reduce((sum, value) => sum + value.fetched, 0)
  const resumedSymbols = marketStats.filter(value => value.resumedFromExisting).length
  const completeSymbols = marketStats.filter(value => value.completeToStart).length
  const backfillRequiredSymbols = marketStats.filter(value => value.skipReason === 'backfillRequired').length
  const unsupportedSymbols = marketStats.filter(value => value.skipReason === 'unsupportedMarket').length
  const unresolvedSymbols = marketStats.filter(value => value.skipReason === 'unresolvedSymbol').length

  logger.info(
    {
      mode: syncMode,
      exchange: exchangeConfig.name,
      markets: markets.length,
      fetched: totalFetched,
      inserted: totalInserted,
      skippedExisting: totalSkippedExisting,
      skippedInvalid: totalSkippedInvalid,
      resumedSymbols,
      completeSymbols,
      backfillRequiredSymbols,
      unsupportedSymbols,
      unresolvedSymbols,
    },
    'Funding rate sync complete for exchange'
  )

  if (exchange.close) {
    try {
      await exchange.close()
    } catch (error) {
      logger.warn({ err: error, exchange: exchangeConfig.name }, 'Failed to close exchange client')
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const current = index
      index += 1
      const item = items[current]
      if (item === undefined) {
        continue
      }

      await worker(item)
    }
  })

  await Promise.all(workers)
}

export async function syncFundingRates(syncMode: FundingRateSyncMode = 'incremental'): Promise<void> {
  await assertClickHouseHealthy()

  const results = await Promise.allSettled(
    EXCHANGE_CONFIGS.map(exchangeConfig =>
      syncExchangeFundingRates(exchangeConfig, syncMode).catch((error: unknown) => {
        logger.error({ err: error, exchange: exchangeConfig.name, mode: syncMode }, 'Funding rate sync failed for exchange')
        throw error
      })
    )
  )

  // Log summary of parallel execution
  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length

  if (failed > 0) {
    const failedExchanges = EXCHANGE_CONFIGS.filter((_, i) => results[i]?.status === 'rejected').map(c => c.name)

    logger.warn({ succeeded, failed, failedExchanges, mode: syncMode }, 'Funding rate sync completed with some failures')
  } else {
    logger.info(
      { succeeded, exchanges: EXCHANGE_CONFIGS.length, mode: syncMode },
      'Funding rate sync completed successfully for all exchanges'
    )
  }

  if (syncMode !== 'backfill') {
    logger.info({ mode: syncMode }, 'Skipping historical funding rate validation for incremental sync')
    return
  }

  try {
    const gaps = await listFundingRateCompletenessGaps()
    if (gaps.length > 0) {
      logger.warn({ count: gaps.length, sample: gaps.slice(0, 25) }, 'Funding rate completeness gaps detected')
    } else {
      logger.info('Funding rate completeness check passed')
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to run funding rate completeness check')
  }

  // Validate symbol counts per exchange
  const dataPeriodStartStr = toClickHouseDateTime(SYNC_DATA_PERIOD_START)
  const dataPeriodEndStr = SYNC_DATA_PERIOD_END ? toClickHouseDateTime(SYNC_DATA_PERIOD_END) : null
  for (const exchangeConfig of EXCHANGE_CONFIGS) {
    try {
      const validation = await validateSymbolsForExchange(exchangeConfig.name, dataPeriodStartStr, dataPeriodEndStr)

      if (!validation.isMatch) {
        logger.warn(
          {
            exchange: validation.exchange,
            expectedCount: validation.expectedSymbols.length,
            actualCount: validation.actualSymbols.length,
            missingCount: validation.missingSymbols.length,
            extraCount: validation.extraSymbols.length,
            missingSymbols: validation.missingSymbols.slice(0, 50), // Limit to first 50 for logging
            extraSymbols: validation.extraSymbols.slice(0, 50), // Limit to first 50 for logging
          },
          'Symbol validation discrepancy detected for exchange'
        )
      } else {
        logger.info(
          {
            exchange: validation.exchange,
            symbolCount: validation.expectedSymbols.length,
          },
          'Symbol validation passed for exchange'
        )
      }
    } catch (error) {
      logger.warn({ err: error, exchange: exchangeConfig.name }, 'Failed to validate symbols for exchange')
    }
  }
}

export {
  buildBackwardFetchRequest,
  buildUnifiedSymbolResolver,
  ensureMarketInExchange,
  getEffectiveRange,
  inferFundingIntervalMs,
  isFundingEligibleMarket,
  isSkippableFundingRateError,
}
