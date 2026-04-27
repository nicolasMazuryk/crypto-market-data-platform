import type { Logger } from 'pino'

import { createCcxtExchange } from '../../exchanges/ccxt-client.js'
import type { ExchangeName } from '../../exchanges/types.js'
import type { ExchangeConfig } from '../config/types.js'
import type { EventBus } from '../core/types.js'
import type { MarketsMetrics } from '../observability/metrics.js'
import type { Exchange, Unsubscribe } from '../types/exchange.js'
import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import { ccxtIdMap } from './ccxtIdMap.js'
import { mapCcxtMarket } from './mapper.js'
import type { MarketMetadata, MarketMetadataDelta, MarketMetadataProvider } from './types.js'

function computeDelta(prev: Map<string, MarketMetadata>, next: Map<string, MarketMetadata>): MarketMetadataDelta {
  const added: MarketMetadata[] = []
  const removed: MarketMetadata[] = []
  const changed: MarketMetadata[] = []

  for (const [symbol, meta] of next) {
    const old = prev.get(symbol)
    if (!old) {
      added.push(meta)
    } else if (isDiffRelevant(old, meta)) {
      changed.push(meta)
    }
  }
  for (const [symbol, meta] of prev) {
    if (!next.has(symbol)) removed.push(meta)
  }

  return { added, removed, changed }
}

function isDiffRelevant(a: MarketMetadata, b: MarketMetadata): boolean {
  return (
    a.contractSize !== b.contractSize ||
    a.pricePrecision !== b.pricePrecision ||
    a.amountPrecision !== b.amountPrecision ||
    a.minPrice !== b.minPrice ||
    a.maxPrice !== b.maxPrice ||
    a.minAmount !== b.minAmount ||
    a.maxAmount !== b.maxAmount ||
    a.minCost !== b.minCost ||
    a.maxLeverage !== b.maxLeverage ||
    a.makerFee !== b.makerFee ||
    a.takerFee !== b.takerFee ||
    a.status !== b.status
  )
}

export interface MarketMetadataProviderOptions {
  bus: EventBus
  logger: Logger
  metrics: MarketsMetrics
  exchanges: ExchangeConfig[]
}

export interface MarketMetadataProviderHandle {
  provider: MarketMetadataProvider
  start: () => Promise<void>
  stop: () => Promise<void>
}

export function createMarketMetadataProvider(options: MarketMetadataProviderOptions): MarketMetadataProviderHandle {
  const { bus, logger, metrics } = options
  const store = new Map<Exchange, Map<string, MarketMetadata>>()
  const ccxtSymbolStore = new Map<Exchange, Map<string, string>>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const activeExchanges = options.exchanges.filter(e => e.enabled && e.exchange in ccxtIdMap)

  async function refreshOne(exchange: Exchange): Promise<void> {
    const ccxtId = ccxtIdMap[exchange]
    if (!ccxtId) {
      logger.warn({ exchange }, 'no CCXT id for exchange, skipping refresh')
      return
    }

    const startMs = Date.now()
    try {
      const ccxtExchange = createCcxtExchange({ name: exchange as ExchangeName, ccxtId })
      await ccxtExchange.loadMarkets()

      const nextMap = new Map<string, MarketMetadata>()
      const nextCcxtMap = new Map<string, string>()
      for (const [unified, market] of Object.entries(ccxtExchange.markets)) {
        nextCcxtMap.set(normalizeSymbol(unified), unified)
        const meta = mapCcxtMarket(exchange, market)
        if (meta) nextMap.set(meta.symbol, meta)
      }
      ccxtSymbolStore.set(exchange, nextCcxtMap)

      const prevMap = store.get(exchange) ?? new Map<string, MarketMetadata>()
      const delta = computeDelta(prevMap, nextMap)
      store.set(exchange, nextMap)

      const durationMs = Date.now() - startMs
      metrics.refreshDurationMs.observe(durationMs, { exchange })
      metrics.refreshTotal.inc(1, { exchange, status: 'ok' })

      let tradingCount = 0
      let haltedCount = 0
      for (const m of nextMap.values()) {
        if (m.status === 'trading') tradingCount++
        else haltedCount++
      }
      metrics.total.set(tradingCount, { exchange, status: 'trading' })
      metrics.total.set(haltedCount, { exchange, status: 'halted' })

      if (delta.added.length > 0 || delta.removed.length > 0 || delta.changed.length > 0) {
        bus.emit('markets.updated', delta)
      }

      logger.info(
        {
          exchange,
          total: nextMap.size,
          added: delta.added.length,
          removed: delta.removed.length,
          changed: delta.changed.length,
          durationMs,
        },
        'markets.refreshed'
      )
    } catch (err) {
      const durationMs = Date.now() - startMs
      metrics.refreshDurationMs.observe(durationMs, { exchange })
      metrics.refreshTotal.inc(1, { exchange, status: 'error' })
      logger.error({ exchange, err }, 'markets.refresh.failed')
    }
  }

  async function refresh(exchange?: Exchange): Promise<void> {
    if (exchange !== undefined) {
      await refreshOne(exchange)
      return
    }
    await Promise.allSettled(activeExchanges.map(e => refreshOne(e.exchange)))
  }

  const provider: MarketMetadataProvider = {
    list: (exchange: Exchange) => [...(store.get(exchange)?.values() ?? [])],
    get: (exchange: Exchange, symbol: string) => store.get(exchange)?.get(symbol),
    resolve: (exchange: Exchange, normalized: string) => ccxtSymbolStore.get(exchange)?.get(normalized),
    refresh,
    onUpdate: (listener: (delta: MarketMetadataDelta) => void): Unsubscribe => bus.on('markets.updated', listener),
  }

  const start = async (): Promise<void> => {
    await refresh()
    for (const { exchange, marketRefreshMs } of activeExchanges) {
      const timer = setInterval(() => {
        void refreshOne(exchange)
      }, marketRefreshMs)
      timers.add(timer)
    }
  }

  const stop = (): Promise<void> => {
    for (const timer of timers) clearInterval(timer)
    timers.clear()
    return Promise.resolve()
  }

  return { provider, start, stop }
}
