import type { Logger } from 'pino'

import type { Exchange, Unsubscribe } from '../types/exchange.js'
import type { ExchangeRestAdapter } from '../adapters/rest/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import type { ExecutionManager } from './types.js'
import type { StrategyConfig } from '../strategies/types.js'
import type { AccountConfigMetrics } from '../observability/metrics.js'

// Exchanges where position mode is set once account-wide (not per-symbol)
const ACCOUNT_WIDE_POSITION_MODE = new Set<Exchange>(['binance', 'okx', 'bitget', 'gateio'])
// Exchanges where position mode must be set per-symbol
const PER_SYMBOL_POSITION_MODE = new Set<Exchange>(['bybit', 'kucoin'])

export interface ExchangeAccountConfigurerOpts {
  adapters: Map<Exchange, ExchangeRestAdapter>
  marketsProvider: MarketMetadataProvider
  exchanges: Exchange[]
  configsByStrategy: Map<string, StrategyConfig>
  execManager: ExecutionManager
  logger: Logger
  metrics: AccountConfigMetrics
}

export interface ExchangeAccountConfigurer {
  configureAccountWide(): Promise<void>
  prewarmSymbol(exchange: Exchange, symbol: string, leverage: number): void
  start(): void
  stop(): void
}

export function createExchangeAccountConfigurer(opts: ExchangeAccountConfigurerOpts): ExchangeAccountConfigurer {
  const { adapters, marketsProvider, exchanges, configsByStrategy, execManager, logger, metrics } = opts

  const marginModeSet = new Set<string>()
  const marginModeInFlight = new Map<string, Promise<void>>()
  const positionModeSet = new Set<string>()
  const positionModeInFlight = new Map<string, Promise<void>>()
  const stopFns: Unsubscribe[] = []

  function getEnabledLeverages(): Set<number> {
    const leverages = new Set<number>()
    for (const cfg of configsByStrategy.values()) {
      if (cfg.enabled) leverages.add(cfg.leverage)
    }
    return leverages
  }

  function ensureMarginMode(exchange: Exchange, exchangeSymbol: string, symbol: string): Promise<void> {
    const key = `${exchange}:${symbol}`
    if (marginModeSet.has(key)) return Promise.resolve()
    const existing = marginModeInFlight.get(key)
    if (existing) return existing

    const adapter = adapters.get(exchange)
    if (!adapter) return Promise.resolve()

    const p = adapter
      .setMarginMode(exchangeSymbol, 'cross')
      .then(() => {
        marginModeSet.add(key)
        logger.info(
          { event: 'accountConfig.margin_mode_set', exchange, symbol, mode: 'cross' },
          'accountConfig.margin_mode_set'
        )
        metrics.calls.inc(1, { exchange, setting: 'margin_mode', status: 'ok' })
      })
      .catch((err: unknown) => {
        logger.warn(
          { event: 'accountConfig.margin_mode_failed', exchange, symbol, err },
          'accountConfig.margin_mode_failed'
        )
        metrics.calls.inc(1, { exchange, setting: 'margin_mode', status: 'error' })
      })
      .finally(() => {
        marginModeInFlight.delete(key)
      })
    marginModeInFlight.set(key, p)
    return p
  }

  function ensurePerSymbolPositionMode(exchange: Exchange, exchangeSymbol: string, symbol: string): Promise<void> {
    const key = `${exchange}:${symbol}`
    if (positionModeSet.has(key)) return Promise.resolve()
    const existing = positionModeInFlight.get(key)
    if (existing) return existing

    const adapter = adapters.get(exchange)
    if (!adapter) return Promise.resolve()

    const p = adapter
      .setPositionMode(false, exchangeSymbol)
      .then(() => {
        positionModeSet.add(key)
        logger.info({ event: 'accountConfig.position_mode_set', exchange, symbol }, 'accountConfig.position_mode_set')
        metrics.calls.inc(1, { exchange, setting: 'position_mode', status: 'ok' })
      })
      .catch((err: unknown) => {
        logger.warn(
          { event: 'accountConfig.position_mode_failed', exchange, symbol, err },
          'accountConfig.position_mode_failed'
        )
        metrics.calls.inc(1, { exchange, setting: 'position_mode', status: 'error' })
      })
      .finally(() => {
        positionModeInFlight.delete(key)
      })
    positionModeInFlight.set(key, p)
    return p
  }

  async function configureAccountWide(): Promise<void> {
    const failures: { exchange: Exchange; err: unknown }[] = []

    await Promise.allSettled(
      exchanges
        .filter(ex => ACCOUNT_WIDE_POSITION_MODE.has(ex))
        .map(async ex => {
          const adapter = adapters.get(ex)
          if (!adapter) return
          try {
            await adapter.setPositionMode(false)
            logger.info({ event: 'accountConfig.position_mode_set', exchange: ex }, 'accountConfig.position_mode_set')
            metrics.calls.inc(1, { exchange: ex, setting: 'position_mode', status: 'ok' })
          } catch (err) {
            logger.error(
              { event: 'accountConfig.position_mode_failed', exchange: ex, err },
              'accountConfig.position_mode_failed'
            )
            metrics.calls.inc(1, { exchange: ex, setting: 'position_mode', status: 'error' })
            failures.push({ exchange: ex, err })
          }
        })
    )

    if (failures.length > 0) {
      const msg = failures.map(f => `${f.exchange}: ${String(f.err)}`).join('; ')
      throw new Error(`configureAccountWide failed for: ${msg}`)
    }
  }

  function prewarmSymbol(exchange: Exchange, symbol: string, leverage: number): void {
    const market = marketsProvider.get(exchange, symbol)
    if (!market) return

    void ensureMarginMode(exchange, market.exchangeSymbol, symbol)

    if (PER_SYMBOL_POSITION_MODE.has(exchange)) {
      void ensurePerSymbolPositionMode(exchange, market.exchangeSymbol, symbol)
    }

    execManager.prewarmLeverage(exchange, symbol, leverage)
  }

  function start(): void {
    const unsub = marketsProvider.onUpdate(delta => {
      if (delta.added.length === 0) return
      const leverages = getEnabledLeverages()
      if (leverages.size === 0) return
      for (const market of delta.added) {
        if (!exchanges.includes(market.exchange)) continue
        for (const leverage of leverages) {
          prewarmSymbol(market.exchange, market.symbol, leverage)
        }
      }
    })
    stopFns.push(unsub)
  }

  function stop(): void {
    for (const fn of stopFns) fn()
    stopFns.length = 0
  }

  return { configureAccountWide, prewarmSymbol, start, stop }
}
