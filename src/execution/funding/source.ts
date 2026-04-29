import type { Logger } from 'pino'

import type { CcxtExchange } from '../../exchanges/types.js'
import type { ExchangeConfig } from '../config/types.js'
import type { EventBus } from '../core/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import type { FundingMetrics } from '../observability/metrics.js'
import type { Exchange, Unsubscribe } from '../types/exchange.js'
import { createBinancePuller } from './binance.js'
import { createBitgetPuller } from './bitget.js'
import { createBybitPuller } from './bybit.js'
import { createOkxPuller } from './okx.js'
import { createGateioPuller } from './gateio.js'
import { createKucoinPuller } from './kucoin.js'
import type { ExchangeFundingPuller, FundingRateSource, FundingSnapshot } from './types.js'

export interface FundingRateSourceOptions {
  bus: EventBus
  logger: Logger
  metrics: FundingMetrics
  exchanges: ExchangeConfig[]
  markets?: MarketMetadataProvider
  ccxtFactory?: (exchange: Exchange) => CcxtExchange
  fundingTimeOverrideMs?: number
}

export interface FundingRateSourceHandle {
  source: FundingRateSource
  start(): Promise<void>
  stop(): Promise<void>
}

function buildPullers(
  exchanges: ExchangeConfig[],
  ccxtFactory: ((exchange: Exchange) => CcxtExchange) | undefined
): ExchangeFundingPuller[] {
  const pullers: ExchangeFundingPuller[] = []
  for (const cfg of exchanges.filter(e => e.enabled)) {
    if (cfg.exchange === 'binance') {
      pullers.push(createBinancePuller(ccxtFactory ? () => ccxtFactory('binance') : undefined))
    } else if (cfg.exchange === 'bitget') {
      pullers.push(createBitgetPuller(ccxtFactory ? () => ccxtFactory('bitget') : undefined))
    } else if (cfg.exchange === 'bybit') {
      pullers.push(createBybitPuller(ccxtFactory ? () => ccxtFactory('bybit') : undefined))
    } else if (cfg.exchange === 'okx') {
      pullers.push(createOkxPuller(ccxtFactory ? () => ccxtFactory('okx') : undefined))
    } else if (cfg.exchange === 'gateio') {
      pullers.push(createGateioPuller(ccxtFactory ? () => ccxtFactory('gateio') : undefined))
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (cfg.exchange === 'kucoin') {
      pullers.push(createKucoinPuller())
    }
  }
  return pullers
}

export function createFundingRateSource(options: FundingRateSourceOptions): FundingRateSourceHandle {
  const { bus, logger, metrics } = options
  const store = new Map<Exchange, Map<string, FundingSnapshot>>()
  let overrideWarned = false
  const timers = new Map<Exchange, ReturnType<typeof setInterval>>()
  const inFlight = new Map<Exchange, boolean>()
  let unsubMarkets: Unsubscribe | undefined

  const pullers = buildPullers(options.exchanges, options.ccxtFactory)

  const fundingPullMsFor = (exchange: Exchange): number => {
    const cfg = options.exchanges.find(e => e.exchange === exchange)
    return cfg?.fundingPullMs ?? 15_000
  }

  function getOrCreateStore(exchange: Exchange): Map<string, FundingSnapshot> {
    let map = store.get(exchange)
    if (!map) {
      map = new Map()
      store.set(exchange, map)
    }
    return map
  }

  const PULL_TIMEOUT_MS = 20_000

  function withPullTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`funding pull timeout after ${PULL_TIMEOUT_MS}ms`)), PULL_TIMEOUT_MS)
      ),
    ])
  }

  async function pullOne(puller: ExchangeFundingPuller): Promise<void> {
    const { exchange } = puller

    if (inFlight.get(exchange)) {
      logger.warn({ exchange }, 'funding.pull.skipped')
      metrics.pullTotal.inc(1, { exchange, status: 'skipped' })
      return
    }

    inFlight.set(exchange, true)
    const startMs = Date.now()

    try {
      const rawSnapshots = await withPullTimeout(puller.pull())
      const durationMs = Date.now() - startMs
      metrics.pullDurationMs.observe(durationMs, { exchange })
      metrics.pullTotal.inc(1, { exchange, status: 'ok' })

      let snapshots = rawSnapshots
      if (options.fundingTimeOverrideMs !== undefined) {
        const overrideMs = options.fundingTimeOverrideMs
        if (!overrideWarned) {
          overrideWarned = true
          logger.warn(
            {
              event: 'funding.override.active',
              exchange,
              target: overrideMs,
              targetIso: new Date(overrideMs).toISOString(),
              deltaMs: overrideMs - Date.now(),
            },
            'funding.override.active'
          )
        }
        snapshots = rawSnapshots.map(snap => ({
          ...snap,
          nextFundingTimestamp: overrideMs,
          nextFundingDatetime: new Date(overrideMs).toISOString(),
        }))
        metrics.overrideAppliedTotal.inc(snapshots.length, { exchange })
      }

      const exchangeStore = getOrCreateStore(exchange)
      let emitted = 0

      for (const snap of snapshots) {
        const existing = exchangeStore.get(snap.symbol)
        const changedFundingRate = existing?.fundingRate !== snap.fundingRate
        const changedNextFunding = existing?.nextFundingTimestamp !== snap.nextFundingTimestamp
        const changed = changedFundingRate || changedNextFunding
        exchangeStore.set(snap.symbol, snap)
        if (changed) {
          bus.emit('funding.snapshot', snap)
          emitted++
        }
      }

      metrics.snapshotsTotal.set(exchangeStore.size, { exchange })

      const fundingPullMs = fundingPullMsFor(exchange)
      const staleThreshold = Date.now() - 2 * fundingPullMs
      let staleCount = 0
      for (const snap of exchangeStore.values()) {
        if (snap.timestamp < staleThreshold) staleCount++
      }
      metrics.snapshotsStale.set(staleCount, { exchange })

      if (options.markets) {
        const listedSymbols = new Set(options.markets.list(exchange).map(m => m.symbol))
        const orphans: string[] = []
        for (const symbol of exchangeStore.keys()) {
          if (!listedSymbols.has(symbol)) orphans.push(symbol)
        }
        if (orphans.length > 0) {
          for (const symbol of orphans) exchangeStore.delete(symbol)
          logger.info({ exchange, count: orphans.length, reason: 'reconcile_orphan' }, 'funding.snapshot.evicted')
          metrics.evictedTotal.inc(orphans.length, { exchange, reason: 'reconcile_orphan' })
          metrics.snapshotsTotal.set(exchangeStore.size, { exchange })
        }
      }

      logger.info({ exchange, total: snapshots.length, emitted, durationMs }, 'funding.refreshed')
    } catch (err) {
      const durationMs = Date.now() - startMs
      metrics.pullDurationMs.observe(durationMs, { exchange })
      metrics.pullTotal.inc(1, { exchange, status: 'error' })
      logger.error({ exchange, err }, 'funding.pull.failed')
    } finally {
      inFlight.set(exchange, false)
    }
  }

  const source: FundingRateSource = {
    latest(exchange: Exchange): Map<string, FundingSnapshot> {
      return new Map<string, FundingSnapshot>(store.get(exchange) ?? [])
    },

    onSnapshot(listener: (snapshot: FundingSnapshot) => void): Unsubscribe {
      return bus.on('funding.snapshot', listener)
    },

    async start(): Promise<void> {
      if (options.markets) {
        unsubMarkets = options.markets.onUpdate(delta => {
          if (delta.removed.length === 0) return
          const byExchange = new Map<Exchange, string[]>()
          for (const m of delta.removed) {
            const list = byExchange.get(m.exchange) ?? []
            list.push(m.symbol)
            byExchange.set(m.exchange, list)
          }
          for (const [exchange, symbols] of byExchange) {
            const exchangeStore = store.get(exchange)
            if (!exchangeStore) continue
            const evicted: string[] = []
            for (const symbol of symbols) {
              if (exchangeStore.delete(symbol)) evicted.push(symbol)
            }
            if (evicted.length > 0) {
              logger.info(
                { exchange, symbols: evicted, count: evicted.length, reason: 'market_removed' },
                'funding.snapshot.evicted'
              )
              metrics.evictedTotal.inc(evicted.length, { exchange, reason: 'market_removed' })
              metrics.snapshotsTotal.set(exchangeStore.size, { exchange })
            }
          }
        })
      }

      await Promise.allSettled(pullers.map(p => pullOne(p)))

      for (const puller of pullers) {
        const { exchange } = puller
        const fundingPullMs = fundingPullMsFor(exchange)
        const timer = setInterval(() => {
          void pullOne(puller)
        }, fundingPullMs)
        timers.set(exchange, timer)
      }

      logger.info({ event: 'funding.started', exchanges: pullers.map(p => p.exchange) }, 'funding.started')
    },

    stop(): Promise<void> {
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
      unsubMarkets?.()
      unsubMarkets = undefined
      return Promise.resolve()
    },
  }

  return {
    source,
    start: () => source.start(),
    stop: () => source.stop(),
  }
}
