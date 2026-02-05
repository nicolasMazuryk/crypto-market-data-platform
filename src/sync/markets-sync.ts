import { EXCHANGE_CONFIGS } from '../exchanges/index.js'
import { fetchActiveMarkets } from '../exchanges/fetcher.js'
import { createExchangeSymbolResolver } from '../exchanges/symbol-resolver.js'
import type { Market } from '../exchanges/types.js'
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
      console.warn(
        `[markets-sync] Failed to fetch active markets for ${exchangeConfig.name}`,
        error
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
      console.warn(
        `[markets-sync] Failed to load delistings for ${exchangeConfig.name}`,
        error
      )
    }

    const mergedMarkets = mergeMarkets(activeMarkets, delistedMarkets)

    totalActive += activeMarkets.length
    totalDelisted += delistedMarkets.length
    totalMerged += mergedMarkets.length

    allMarkets.push(...mergedMarkets)

    console.log(
      `[markets-sync] ${exchangeConfig.name}: active=${activeMarkets.length} delisted=${delistedMarkets.length} merged=${mergedMarkets.length}`
    )
  }

  console.log(
    `[markets-sync] total: active=${totalActive} delisted=${totalDelisted} merged=${totalMerged}`
  )

  return allMarkets
}
