import type { CcxtMarket } from '../../exchanges/types.js'
import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import type { Exchange } from '../types/exchange.js'
import type { MarketMetadata, MarketStatus } from './types.js'

function isUsdtMPerpType(market: CcxtMarket): boolean {
  if (market.swap !== true) return false
  if (market.linear !== true) return false
  const settle = typeof market.settle === 'string' ? market.settle.toUpperCase() : ''
  return settle === 'USDT'
}

function numOf(obj: unknown, key: string): number | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined
  const v = (obj as Record<string, unknown>)[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return undefined
}

function extractMaxLeverage(exchange: Exchange, info: Record<string, unknown>): number | undefined {
  if (exchange === 'binance') {
    const ml = info.maxLeverage
    if (typeof ml === 'number' && ml > 0) return ml
    const brackets = info.brackets
    if (Array.isArray(brackets) && brackets.length > 0) {
      const first = brackets[0] as Record<string, unknown>
      const il = first.initialLeverage
      if (typeof il === 'number' && il > 0) return il
    }
    return undefined
  }
  if (exchange === 'bitget') {
    const ml = info.maxLever ?? info.maxLeverage
    if (typeof ml === 'number' && ml > 0) return ml
    if (typeof ml === 'string') {
      const n = parseFloat(ml)
      if (Number.isFinite(n) && n > 0) return n
    }
    return undefined
  }
  if (exchange === 'bybit') {
    const lf = info.leverageFilter
    if (typeof lf === 'object' && lf !== null) {
      const ml = (lf as Record<string, unknown>).maxLeverage
      if (typeof ml === 'string') {
        const n = parseFloat(ml)
        if (Number.isFinite(n) && n > 0) return n
      }
      if (typeof ml === 'number' && ml > 0) return ml
    }
    return undefined
  }
  if (exchange === 'okx') {
    // OKX returns leverage as a string in info.lever
    const ml = info.lever ?? info.maxLeverage
    if (typeof ml === 'string') {
      const n = parseFloat(ml)
      if (Number.isFinite(n) && n > 0) return n
    }
    if (typeof ml === 'number' && ml > 0) return ml
    return undefined
  }
  if (exchange === 'gateio') {
    // Gate.io returns leverage_min/leverage_max as numbers in info
    const ml = info.leverage_max ?? info.max_leverage
    if (typeof ml === 'number' && ml > 0) return ml
    if (typeof ml === 'string') {
      const n = parseFloat(ml)
      if (Number.isFinite(n) && n > 0) return n
    }
    return undefined
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (exchange === 'kucoin') {
    const ml = info.maxLeverage ?? info.multiplier
    if (typeof ml === 'number' && ml > 0) return ml
    if (typeof ml === 'string') {
      const n = parseFloat(ml)
      if (Number.isFinite(n) && n > 0) return n
    }
    return undefined
  }
  return undefined
}

export function mapCcxtMarket(exchange: Exchange, raw: CcxtMarket): MarketMetadata | null {
  if (!isUsdtMPerpType(raw)) return null

  const precision =
    typeof raw.precision === 'object' && raw.precision !== null ? (raw.precision as Record<string, unknown>) : {}
  const limits = typeof raw.limits === 'object' && raw.limits !== null ? (raw.limits as Record<string, unknown>) : {}
  const priceLimits =
    typeof limits.price === 'object' && limits.price !== null ? (limits.price as Record<string, unknown>) : {}
  const amountLimits =
    typeof limits.amount === 'object' && limits.amount !== null ? (limits.amount as Record<string, unknown>) : {}
  const costLimits =
    typeof limits.cost === 'object' && limits.cost !== null ? (limits.cost as Record<string, unknown>) : {}

  const contractSizeRaw = raw.contractSize
  const contractSize = typeof contractSizeRaw === 'number' && contractSizeRaw > 0 ? contractSizeRaw : 1
  const makerRaw = raw.maker
  const takerRaw = raw.taker
  const makerFee = typeof makerRaw === 'number' ? makerRaw : 0
  const takerFee = typeof takerRaw === 'number' ? takerRaw : 0
  const status: MarketStatus = raw.active !== false ? 'trading' : 'halted'
  const maxLeverage = extractMaxLeverage(exchange, raw.info ?? {})

  const meta: MarketMetadata = {
    exchange,
    symbol: normalizeSymbol(raw.symbol),
    exchangeSymbol: raw.id,
    contractSize,
    pricePrecision: numOf(precision, 'price') ?? 0,
    amountPrecision: numOf(precision, 'amount') ?? 0,
    makerFee,
    takerFee,
    status,
  }

  const minPrice = numOf(priceLimits, 'min')
  if (minPrice !== undefined) meta.minPrice = minPrice
  const maxPrice = numOf(priceLimits, 'max')
  if (maxPrice !== undefined) meta.maxPrice = maxPrice
  const minAmount = numOf(amountLimits, 'min')
  if (minAmount !== undefined) meta.minAmount = minAmount
  const maxAmount = numOf(amountLimits, 'max')
  if (maxAmount !== undefined) meta.maxAmount = maxAmount
  const minCost = numOf(costLimits, 'min')
  if (minCost !== undefined) meta.minCost = minCost
  if (maxLeverage !== undefined) meta.maxLeverage = maxLeverage

  return meta
}
