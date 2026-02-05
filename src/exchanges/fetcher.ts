import ccxt from 'ccxt'

import { normalizeSymbol } from '../utils/symbol-normalizer.js'
import { extractListingDate } from './listing-date.js'
import type { CcxtExchange, CcxtMarket, ExchangeConfig, Market } from './types.js'

type CcxtConstructor = new (config?: Record<string, unknown>) => CcxtExchange

function createExchange(exchangeConfig: ExchangeConfig): CcxtExchange {
  const ccxtRegistry = ccxt as unknown as Record<string, CcxtConstructor>
  const ExchangeClass = ccxtRegistry[exchangeConfig.ccxtId]

  if (!ExchangeClass) {
    throw new Error(`Unsupported CCXT exchange id: ${exchangeConfig.ccxtId}`)
  }

  return new ExchangeClass({
    enableRateLimit: true,
    options: exchangeConfig.options ?? {}
  })
}

function isUsdtPerpetualMarket(market: CcxtMarket): boolean {
  if (market.swap !== true) {
    return false
  }

  if (market.linear !== true) {
    return false
  }

  const settle = typeof market.settle === 'string' ? market.settle.toUpperCase() : ''
  if (settle !== 'USDT') {
    return false
  }

  const isActive = market.active === undefined ? true : market.active === true
  if (!isActive) {
    return false
  }

  return true
}

function toMarketRecord(exchange: ExchangeConfig, market: CcxtMarket): Market {
  const symbol = normalizeSymbol(market.symbol)
  const exchangeSymbol = market.id ?? market.symbol

  return {
    exchange: exchange.name,
    symbol,
    exchange_symbol: exchangeSymbol,
    type: 'perpetual',
    listing_date: extractListingDate(exchange.name, market.info),
    delisting_date: null,
    is_active: true
  }
}

export async function fetchActiveMarkets(
  exchangeConfig: ExchangeConfig
): Promise<Market[]> {
  const exchange = createExchange(exchangeConfig)

  await exchange.loadMarkets()

  const markets = Object.values(exchange.markets ?? {})

  return markets.filter(isUsdtPerpetualMarket).map((market) => {
    return toMarketRecord(exchangeConfig, market)
  })
}
