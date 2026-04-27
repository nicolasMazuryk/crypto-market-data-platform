import type { CcxtFundingRate, CcxtMarket } from '../../exchanges/types.js'
import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import type { FundingInterval } from '../types/exchange.js'
import type { Exchange } from '../types/exchange.js'
import type { FundingSnapshot } from './types.js'

const BINANCE_DEFAULT_FUNDING_INTERVAL: FundingInterval = 8

function isUsdtMPerp(market: CcxtMarket): boolean {
  if (market.swap !== true || market.linear !== true) return false
  const settle = typeof market.settle === 'string' ? market.settle.toUpperCase() : ''
  return settle === 'USDT'
}

function parseInterval(interval: string | undefined): FundingInterval | null {
  if (!interval) return null
  const m = /^(\d+)h$/.exec(interval)
  if (!m?.[1]) return null
  const n = parseInt(m[1], 10)
  if (n === 1 || n === 2 || n === 4 || n === 8) return n as FundingInterval
  return null
}

function readNumeric(info: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!info) return null

  for (const key of keys) {
    if (!(key in info)) continue
    const value = info[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }

  return null
}

function parseIntervalFromHours(hours: number | null): FundingInterval | null {
  if (hours === 1 || hours === 2 || hours === 4 || hours === 8) {
    return hours as FundingInterval
  }
  return null
}

function inferFundingInterval(exchange: Exchange, raw: CcxtFundingRate): FundingInterval | null {
  const unified = parseInterval(raw.interval)
  if (unified !== null) return unified
  if (raw.interval !== undefined) return null

  const info = raw.info
  const hours = readNumeric(info, ['fundingIntervalHours', 'funding_interval_hours', 'fundingRateIntervalHours'])
  const parsedHours = parseIntervalFromHours(hours)
  if (parsedHours !== null) return parsedHours

  const minutes = readNumeric(info, [
    'fundingInterval',
    'funding_interval',
    'fundingRateInterval',
    'fundingRateIntervalMinutes',
  ])
  const parsedMinutes = minutes === null ? null : parseIntervalFromHours(minutes / 60)
  if (parsedMinutes !== null) return parsedMinutes

  // Binance's unified funding-rate payload currently omits `interval` for USDT-M perps.
  if (exchange === 'binance') return BINANCE_DEFAULT_FUNDING_INTERVAL

  return null
}

function extractMarkPrice(raw: CcxtFundingRate): number | undefined {
  const top = raw.markPrice
  if (typeof top === 'number' && Number.isFinite(top) && top > 0) return top
  if (typeof top === 'string') {
    const n = Number(top)
    if (Number.isFinite(n) && n > 0) return n
  }
  const fromInfo = readNumeric(raw.info, ['markPrice', 'mark_price'])
  return fromInfo !== null && fromInfo > 0 ? fromInfo : undefined
}

export function mapCcxtFundingRate(
  exchange: Exchange,
  raw: CcxtFundingRate,
  markets: Record<string, CcxtMarket>
): FundingSnapshot | null {
  const market = markets[raw.symbol]
  if (!market || !isUsdtMPerp(market)) return null

  if (typeof raw.fundingRate !== 'number' || !Number.isFinite(raw.fundingRate)) return null
  if (typeof raw.fundingTimestamp !== 'number' || !Number.isFinite(raw.fundingTimestamp)) return null

  const interval = inferFundingInterval(exchange, raw)
  if (interval === null) return null

  const markPrice = extractMarkPrice(raw)

  return {
    exchange,
    symbol: normalizeSymbol(raw.symbol),
    exchangeSymbol: market.id,
    fundingRate: raw.fundingRate,
    fundingRatePercent: raw.fundingRate * 100,
    fundingInterval: interval,
    nextFundingTimestamp: raw.fundingTimestamp,
    nextFundingDatetime: new Date(raw.fundingTimestamp).toISOString(),
    timestamp: Date.now(),
    ...(markPrice !== undefined ? { markPrice } : {}),
  }
}
