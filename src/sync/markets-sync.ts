import { EXCHANGE_CONFIGS } from '../exchanges/index.js'
import { fetchActiveMarkets } from '../exchanges/fetcher.js'
import { createExchangeSymbolResolver } from '../exchanges/symbol-resolver.js'
import type { Market } from '../exchanges/types.js'
import { logger } from '../logger.js'
import { loadDelistingsForExchange } from './delistings-loader.js'

function mergeMarkets(active: Market[], delisted: Market[]): Market[] {
  const merged = new Map<string, Market>()

  for (const market of delisted) {
    const key = `${market.exchange}:${market.symbol}`
    merged.set(key, market)
  }

  for (const market of active) {
    const key = `${market.exchange}:${market.symbol}`
    merged.set(key, market)
  }

  return Array.from(merged.values())
}

export async function syncMarkets(): Promise<Market[]> {
  const allMarkets: Market[] = []
  let totalActive = 0
  let totalDelisted = 0
  let totalMerged = 0

  for (const exchangeConfig of EXCHANGE_CONFIGS) {
    let activeMarkets: Market[] = []
    let delistedMarkets: Market[] = []

    try {
      activeMarkets = await fetchActiveMarkets(exchangeConfig)
    } catch (error) {
      logger.warn(
        { err: error, exchange: exchangeConfig.name },
        '[markets-sync] Failed to fetch active markets'
      )
    }

    try {
      const resolver = createExchangeSymbolResolver(
        exchangeConfig.name,
        activeMarkets
      )
      delistedMarkets = await loadDelistingsForExchange(
        exchangeConfig.name,
        resolver
      )
    } catch (error) {
      logger.warn(
        { err: error, exchange: exchangeConfig.name },
        '[markets-sync] Failed to load delistings'
      )
    }

    const mergedMarkets = mergeMarkets(activeMarkets, delistedMarkets)

    totalActive += activeMarkets.length
    totalDelisted += delistedMarkets.length
    totalMerged += mergedMarkets.length

    allMarkets.push(...mergedMarkets)

    logger.info(
      {
        exchange: exchangeConfig.name,
        active: activeMarkets.length,
        delisted: delistedMarkets.length,
        merged: mergedMarkets.length,
      },
      '[markets-sync] Exchange summary'
    )
  }

  logger.info(
    {
      active: totalActive,
      delisted: totalDelisted,
      merged: totalMerged,
    },
    '[markets-sync] Total summary'
  )

  return allMarkets
}
