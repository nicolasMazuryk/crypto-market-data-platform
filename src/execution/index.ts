import { parseArgs } from 'node:util'

import { loadEngineConfig } from './config/loader.js'
import { createEventBus } from './core/bus.js'
import { createClock } from './core/clock.js'
import { createIds } from './core/ids.js'
import { createExecutionLogger } from './core/logger.js'
import { createRateLimiter } from './core/ratelimit/tokenBucket.js'
import { createFundingRateSource } from './funding/source.js'
import type { FundingRateSource } from './funding/types.js'
import { ccxtIdMap } from './markets/ccxtIdMap.js'
import { createMarketMetadataProvider } from './markets/provider.js'
import type { MarketMetadataProvider } from './markets/types.js'
import {
  MetricsRegistry,
  registerBaseMetrics,
  registerExecutionMetrics,
  registerFundingMetrics,
  registerMarketsMetrics,
  registerKillSwitchMetrics,
  registerPersistenceMetrics,
  registerRateLimitMetrics,
  registerRestMetrics,
  startMetricsServer,
  type KillSwitchMetrics,
  type MetricsServer,
} from './observability/metrics.js'
import { startHealthServer } from './observability/health.js'
import type { HealthServer } from './observability/health.js'
import { createNoopTracer, createOtelTracer } from './observability/tracing.js'
import type { Tracer } from './observability/types.js'
import { createRestAdapter } from './adapters/rest/factory.js'
import type { ExchangeRestAdapter } from './adapters/rest/types.js'
import { createPrivateWsAdapter } from './adapters/privatews/factory.js'
import type { ExchangePrivateWsAdapter } from './adapters/privatews/types.js'
import { createStateStore } from './state/store.js'
import type { StateStoreHandle } from './state/store.js'
import type { RateLimiter } from './core/types.js'
import { createKillSwitch } from './risk/killSwitch.js'
import { createAlertDispatcher } from './observability/alerts.js'
import { registerPrivateWsMetrics, registerStateMetrics } from './observability/metrics.js'
import { createPositionMonitor } from './execution/monitor.js'
import type { PositionMonitorHandle } from './execution/monitor.js'
import { createExecutionManager } from './execution/manager.js'
import type { ExecutionManagerHandle, ExecutionManagerInitialState } from './execution/manager.js'
import { createStrategyRegistry } from './strategies/registry.js'
import type { StrategyRegistry } from './strategies/registry.js'
import { createStrategyEvaluator } from './strategies/evaluator.js'
import type { StrategyEvaluator } from './strategies/types.js'
import { createStrategy1Rule } from './strategies/strategy_1.js'
import { createStrategy3Rule } from './strategies/strategy_3.js'
import { preflight } from './execution/preflight.js'
import { createFundingEventScheduler } from './execution/scheduler.js'
import type { FundingEventSchedulerHandle } from './execution/scheduler.js'
import type { StrategyConfig, StrategyId } from './strategies/types.js'
import { openDb } from './persistence/db.js'
import type { DbHandle } from './persistence/db.js'
import { createWal } from './persistence/wal.js'
import { createPersistenceWriter, drainWalEntriesToDb } from './persistence/writer.js'
import type { PersistenceWriterHandle } from './persistence/writer.js'
import { runRecovery } from './recovery/index.js'
import type { RecoveryOptions } from './recovery/index.js'

import type { EngineConfig } from './config/types.js'
import type { Exchange } from './types/exchange.js'

export interface EngineHandle {
  config: EngineConfig
  metricsPort: number
  runId?: string
  bus: ReturnType<typeof createEventBus>
  markets?: MarketMetadataProvider
  funding?: FundingRateSource
  restAdapters?: Map<Exchange, ExchangeRestAdapter>
  rateLimiters?: Map<Exchange, RateLimiter>
  state?: StateStoreHandle
  wsAdapters?: Map<Exchange, ExchangePrivateWsAdapter>
  manager?: ExecutionManagerHandle
  monitor?: PositionMonitorHandle
  strategies?: StrategyRegistry
  evaluator?: StrategyEvaluator
  scheduler?: FundingEventSchedulerHandle
  stop: () => Promise<void>
}

export interface StartEngineOptions {
  configPath: string
  exchangeFilter?: Exchange[]
  symbolFilter?: string[]
  metricsPort?: number
  healthPort?: number
  resumeRunId?: string
  skipRecovery?: boolean
  fundingTimeOverride?: string
  ackLiveFundingOverride?: boolean
}

export async function startEngine(options: StartEngineOptions): Promise<EngineHandle> {
  const logger = createExecutionLogger()

  const rawConfig = loadEngineConfig({
    configPath: options.configPath,
    ...(options.fundingTimeOverride !== undefined
      ? {
          cliOverrides: {
            fundingTime: options.fundingTimeOverride,
            ...(options.ackLiveFundingOverride !== undefined
              ? { ackLiveFundingOverride: options.ackLiveFundingOverride }
              : {}),
          },
        }
      : {}),
  })

  const filter = options.exchangeFilter
  const symbolFilter = options.symbolFilter ? new Set(options.symbolFilter) : undefined
  const filteredExchanges =
    filter && filter.length > 0 ? rawConfig.exchanges.filter(e => filter.includes(e.exchange)) : rawConfig.exchanges

  const config: EngineConfig = { ...rawConfig, exchanges: filteredExchanges }

  const bus = createEventBus()
  const clock = createClock()
  const ids = createIds()

  const tracingCfg = config.observability.tracing
  let tracer: Tracer
  if (tracingCfg.enabled) {
    tracer = await createOtelTracer({
      serviceName: tracingCfg.serviceName,
      sampler: tracingCfg.sampler,
      ...(tracingCfg.endpoint !== undefined ? { endpoint: tracingCfg.endpoint } : {}),
    })
    logger.info({ endpoint: tracingCfg.endpoint ?? 'http://localhost:4318/v1/traces' }, 'tracing.enabled')
  } else {
    tracer = createNoopTracer()
  }

  const registry = new MetricsRegistry()
  const enabledExchanges = config.exchanges.filter(e => e.enabled).map(e => e.exchange)
  const enabledStrategies = config.strategies.filter(s => s.enabled).map(s => s.id)
  const startedAtSeconds = Math.floor(Date.now() / 1000)
  registerBaseMetrics(registry, {
    mode: config.mode,
    configHash: config.configHash,
    startedAtSeconds,
    enabledExchanges,
  })
  const killSwitchMetrics: KillSwitchMetrics = registerKillSwitchMetrics(registry, config.mode)
  const marketsMetrics = registerMarketsMetrics(registry)
  const persistenceMetrics = registerPersistenceMetrics(registry)

  const port = options.metricsPort ?? config.observability.metricsPort
  let server: MetricsServer
  try {
    server = await startMetricsServer(registry, port)
  } catch (err) {
    logger.error({ err }, 'failed to start metrics server')
    throw err
  }

  const healthPort = options.healthPort ?? config.observability.healthPort
  let healthServer: HealthServer
  try {
    healthServer = await startHealthServer(healthPort)
  } catch (err) {
    logger.error({ err }, 'failed to start health server')
    await server.close()
    throw err
  }

  let marketsHandle: { provider: MarketMetadataProvider; start(): Promise<void>; stop(): Promise<void> } | undefined

  if (config.exchanges.some(e => e.enabled && e.exchange in ccxtIdMap)) {
    marketsHandle = createMarketMetadataProvider({
      bus,
      logger: logger.childFor('markets'),
      metrics: marketsMetrics,
      exchanges: config.exchanges,
    })
    await marketsHandle.start()
  }

  const fundingExchanges = config.exchanges.filter(e => e.enabled)
  let fundingSource: FundingRateSource | undefined
  if (fundingExchanges.length > 0) {
    const fundingMetrics = registerFundingMetrics(registry)
    const fundingHandle = createFundingRateSource({
      bus,
      logger: logger.childFor('funding'),
      metrics: fundingMetrics,
      exchanges: fundingExchanges,
      ...(marketsHandle ? { markets: marketsHandle.provider } : {}),
      ...(config.testing?.fundingTimeOverride
        ? { fundingTimeOverrideMs: config.testing.fundingTimeOverride.resolvedMs }
        : {}),
    })
    await fundingHandle.start()
    fundingSource = fundingHandle.source
  }

  const restMetrics = registerRestMetrics(registry)
  const rateLimitMetrics = registerRateLimitMetrics(registry)

  const restAdapters = new Map<Exchange, ExchangeRestAdapter>()
  const rateLimiters = new Map<Exchange, RateLimiter>()
  const adapterDisposers: (() => Promise<void>)[] = []

  for (const cfg of config.exchanges.filter(e => e.enabled)) {
    const limiter = createRateLimiter({
      profile: cfg.rateLimits,
      metrics: rateLimitMetrics,
      logger: logger.childFor('ratelimit', { exchange: cfg.exchange }),
    })
    rateLimiters.set(cfg.exchange, limiter)

    try {
      const adapter = createRestAdapter({
        engineMode: config.mode,
        config: cfg,
        limiter,
        clock,
        ids,
        logger: logger.childFor('rest', { exchange: cfg.exchange }),
        metrics: restMetrics,
        bus,
        tracer,
        ...(marketsHandle?.provider !== undefined ? { marketMetadataProvider: marketsHandle.provider } : {}),
        ...(config.testing?.shadowFillDelayMs !== undefined
          ? { shadowFillDelayMs: config.testing.shadowFillDelayMs }
          : {}),
      })
      restAdapters.set(cfg.exchange, adapter)
      if ('dispose' in adapter && typeof adapter.dispose === 'function') {
        adapterDisposers.push(() => (adapter as { dispose(): Promise<void> }).dispose())
      }
    } catch (err) {
      logger.warn({ err, exchange: cfg.exchange }, 'rest.adapter.skipped')
    }
  }

  // Pre-warm all REST adapters (loads markets so the first createOrder has no cold-start penalty)
  await Promise.allSettled(
    Array.from(restAdapters.values()).flatMap(a =>
      a.warm
        ? [
            a.warm().catch((err: unknown) => {
              logger.warn({ err }, 'rest.adapter.warm.failed')
            }),
          ]
        : []
    )
  )

  // Persistence + recovery (ephemeral mode when EXECUTION_POSTGRES_URL is not set)
  let dbHandle: DbHandle | undefined
  let persistenceWriter: PersistenceWriterHandle | undefined
  let runId: string | undefined
  let recoveredInitialState: ExecutionManagerInitialState | undefined

  const postgresUrl = config.persistence.postgresUrl
  if (postgresUrl) {
    try {
      dbHandle = openDb(postgresUrl)
      const wal = createWal(
        config.persistence.walPath || '/tmp/execution-wal.jsonl',
        logger.childFor('wal'),
        config.persistence.walMaxBytes
      )

      if (!options.skipRecovery) {
        // Drain WAL before querying the DB so recovery sees the latest persisted state.
        // Any intent-status or order updates buffered from the previous run are applied first.
        await drainWalEntriesToDb(dbHandle.db, wal, logger.childFor('wal-predrain'))

        const recoveryOpts: RecoveryOptions = {
          db: dbHandle.db,
          config,
          bus,
          restAdapters,
          logger: logger.childFor('recovery'),
          metrics: persistenceMetrics,
          failOnExchangeError: config.mode === 'live',
        }
        if (options.resumeRunId) recoveryOpts.resumeRunId = options.resumeRunId
        const recovery = await runRecovery(recoveryOpts)
        runId = recovery.runId
        recoveredInitialState = recovery.initialState
        logger.info(
          {
            runId,
            rehydratedCount: recovery.rehydratedCount,
            orphansCancelled: recovery.orphansCancelled,
            orphansFlattened: recovery.orphansFlattened,
          },
          'recovery.complete'
        )

        persistenceWriter = createPersistenceWriter({
          db: dbHandle.db,
          wal,
          bus,
          runId,
          logger: logger.childFor('persistence'),
          metrics: persistenceMetrics,
          batchSize: config.persistence.batchSize,
          flushIntervalMs: config.persistence.flushIntervalMs,
        })
      } else {
        runId = 'ephemeral'
        persistenceWriter = createPersistenceWriter({
          db: dbHandle.db,
          wal,
          bus,
          runId,
          logger: logger.childFor('persistence'),
          metrics: persistenceMetrics,
          batchSize: config.persistence.batchSize,
          flushIntervalMs: config.persistence.flushIntervalMs,
        })
      }
    } catch (err) {
      if (config.mode === 'live') {
        logger.fatal({ err }, 'persistence: failed to initialize in live mode — refusing to start without persistence')
        throw err
      }
      logger.warn({ err }, 'persistence: failed to initialize, running ephemeral')
      dbHandle = undefined
    }
  } else {
    if (config.mode === 'live') {
      throw new Error('persistence.postgresUrl must be set in live mode — refusing to start without persistence')
    }
    logger.warn('persistence.postgresUrl not set in config — running in ephemeral mode (no persistence)')
  }

  const wsMetrics = registerPrivateWsMetrics(registry)
  const stateMetrics = registerStateMetrics(registry)

  const stateStore = createStateStore({
    bus,
    restAdapters,
    exchanges: enabledExchanges,
    clock,
    logger: logger.childFor('state'),
    metrics: stateMetrics,
  })
  stateStore.start()

  // Seed initial state via REST for each exchange (critical for dry-run where ws.connection never fires)
  for (const exchange of enabledExchanges) {
    void stateStore.reconcile(exchange)
  }

  const wsAdapters = new Map<Exchange, ExchangePrivateWsAdapter>()
  const wsDisposers: (() => Promise<void>)[] = []

  for (const cfg of config.exchanges.filter(e => e.enabled)) {
    try {
      const ws = createPrivateWsAdapter({
        engineMode: config.mode,
        config: cfg,
        bus,
        clock,
        logger: logger.childFor('privatews', { exchange: cfg.exchange }),
        metrics: wsMetrics,
      })
      ws.connect().catch((err: unknown) => {
        logger.warn({ err, exchange: cfg.exchange }, 'privatews.connect.failed')
      })
      wsAdapters.set(cfg.exchange, ws)
      wsDisposers.push(() => ws.disconnect())
    } catch (err) {
      logger.warn({ err, exchange: cfg.exchange }, 'privatews.adapter.skipped')
    }
  }

  const execMetrics = registerExecutionMetrics(registry)

  const positionMonitor = createPositionMonitor({
    bus,
    clock,
    logger: logger.childFor('monitor'),
    metrics: execMetrics,
  })

  const killSwitch = createKillSwitch(logger, config.mode)

  const alertDispatcher = createAlertDispatcher({
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    logger: logger.childFor('alerts'),
  })
  const unsubDisconnects = alertDispatcher.subscribeToDisconnects(bus)
  const unsubOpsEvents = alertDispatcher.subscribeToBusOpsEvents(bus)

  const strategyRegistry = createStrategyRegistry()

  const configsByStrategy = new Map<StrategyId, StrategyConfig>()
  for (const s of config.strategies) {
    configsByStrategy.set(s.id, s)
  }

  const noopMarkets: MarketMetadataProvider = {
    list: () => [],
    get: () => undefined,
    resolve: () => undefined,
    refresh: () => Promise.resolve(),
    onUpdate: () => () => {
      /* no-op */
    },
  }

  const execManager = createExecutionManager({
    bus,
    clock,
    ids,
    logger: logger.childFor('manager'),
    metrics: execMetrics,
    restAdapters,
    state: stateStore,
    markets: marketsHandle?.provider ?? noopMarkets,
    killSwitch,
    monitor: positionMonitor,
    preflight: (intent, refPriceValue) =>
      preflight(intent, refPriceValue, {
        markets: marketsHandle?.provider ?? noopMarkets,
        state: stateStore,
        killSwitch,
        risk: config.risk,
        countIntents: scope => {
          // Exclude the current intent and terminal states. 'decided' intents from concurrent
          // submissions are intentionally included so the cap check is not a TOCTOU race.
          const active = execManager
            .list()
            .filter(s => !['exited', 'error', 'cancelled'].includes(s.status) && s.intent.id !== intent.id)
          if (scope === 'global') return active.length
          if (typeof scope === 'object' && 'strategy' in scope)
            return active.filter(s => s.intent.strategy === scope.strategy).length
          if (typeof scope === 'object' && 'exchange' in scope)
            return active.filter(s => s.intent.exchange === scope.exchange).length
          return active.length
        },
        notionalInFlight: scope => {
          const active = execManager
            .list()
            .filter(s => !['exited', 'error', 'cancelled'].includes(s.status) && s.intent.id !== intent.id)
          const sumUsd = (list: typeof active) => list.reduce((sum, s) => sum + s.intent.amountUsd, 0)
          if (scope === 'global') return sumUsd(active)
          if (typeof scope === 'object' && 'strategy' in scope)
            return sumUsd(active.filter(s => s.intent.strategy === scope.strategy))
          if (typeof scope === 'object' && 'exchange' in scope)
            return sumUsd(active.filter(s => s.intent.exchange === scope.exchange))
          return sumUsd(active)
        },
      }),
    refPrice: (exchange, symbol) => fundingSource?.latest(exchange).get(symbol)?.markPrice,
    risk: config.risk,
    ...(recoveredInitialState ? { initialState: recoveredInitialState } : {}),
    ...(persistenceWriter ? { beforeCreateOrder: params => persistenceWriter.writeOrderSync(params) } : {}),
  })
  execManager.start()

  // Wire kill switch flattenAll to the manager (breaks the ks ↔ manager dependency cycle)
  killSwitch.wireFlattener(() => execManager.flattenAll())

  // Keep kill_switch_mode metric in sync with runtime mode changes, and page on trip
  const origSetMode = killSwitch.setMode.bind(killSwitch)
  const origTrip = killSwitch.trip.bind(killSwitch)
  killSwitch.setMode = async (mode, reason) => {
    await origSetMode(mode, reason)
    killSwitchMetrics.update(mode)
  }
  killSwitch.trip = async reason => {
    await origTrip(reason)
    killSwitchMetrics.update('halted')
    void alertDispatcher.dispatch('page', 'risk.killSwitch.trip', { reason, mode: config.mode })
  }

  // Start persistence writer after manager is set up
  persistenceWriter?.start()

  let evaluator: StrategyEvaluator | undefined
  if (fundingSource && marketsHandle) {
    const evaluatorOpts = {
      bus,
      clock,
      logger: logger.childFor('evaluator'),
      metrics: execMetrics,
      registry: strategyRegistry,
      funding: fundingSource,
      markets: marketsHandle.provider,
      configsByStrategy,
      tracer,
      ...(symbolFilter ? { symbolFilter } : {}),
    }
    evaluator = createStrategyEvaluator(evaluatorOpts)
  }

  const refPrice = (exchange: Exchange, symbol: string) => fundingSource?.latest(exchange).get(symbol)?.markPrice

  if (configsByStrategy.has('strategy_1')) {
    strategyRegistry.register(createStrategy1Rule({ ids, refPrice }))
  }
  if (configsByStrategy.has('strategy_3a')) {
    strategyRegistry.register(createStrategy3Rule({ variant: 'A', ids, refPrice }))
  }
  if (configsByStrategy.has('strategy_3b')) {
    strategyRegistry.register(createStrategy3Rule({ variant: 'B', ids, refPrice }))
  }

  let scheduler: FundingEventSchedulerHandle | undefined
  if (evaluator && fundingSource) {
    scheduler = createFundingEventScheduler({
      clock,
      evaluator,
      funding: fundingSource,
      exchanges: enabledExchanges,
      configsByStrategy,
      config: config.scheduler,
      leveragePrewarmer: (ex, sym, lev) => {
        execManager.prewarmLeverage(ex, sym, lev)
      },
      ...(symbolFilter ? { symbolFilter } : {}),
      ...(config.testing?.fundingTimeOverride
        ? { fundingTimeOverrideMs: config.testing.fundingTimeOverride.resolvedMs }
        : {}),
      logger: logger.childFor('scheduler'),
    })
  }

  bus.on('intent.decided', intent => {
    void (async () => {
      // Write the intent row to DB before calling submit so that the beforeCreateOrder
      // durability write (writeOrderSync) finds the parent row and avoids FK violation.
      if (persistenceWriter) {
        try {
          await persistenceWriter.writeIntentSync(intent)
        } catch (err) {
          logger.warn({ intentId: intent.id, err }, 'intent pre-write failed, continuing')
        }
      }
      await execManager.submit(intent)
    })()
  })

  const marketCounts: Partial<Record<Exchange, number>> = {}
  if (marketsHandle) {
    for (const ex of enabledExchanges) {
      marketCounts[ex] = marketsHandle.provider.list(ex).length
    }
  }

  healthServer.setReady(true)

  logger.info(
    {
      event: 'engine.started',
      mode: config.mode,
      configHash: config.configHash,
      gitSha: config.gitSha,
      enabledExchanges,
      enabledStrategies,
      metricsPort: server.port,
      healthPort: healthServer.port,
      markets: Object.keys(marketCounts).length > 0 ? marketCounts : undefined,
    },
    'engine.started'
  )

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true

    unsubDisconnects()
    unsubOpsEvents()

    // Log any open intents before we close them (F6-10: position accounting at shutdown)
    const openAtShutdown = execManager.list().filter(s => !['exited', 'error', 'cancelled'].includes(s.status))
    if (openAtShutdown.length > 0) {
      logger.warn(
        {
          event: 'shutdown.open_intents',
          count: openAtShutdown.length,
          intents: openAtShutdown.map(s => ({
            intentId: s.intent.id,
            exchange: s.intent.exchange,
            symbol: s.intent.symbol,
            strategy: s.intent.strategy,
            status: s.status,
            filledQty: s.filledQty,
          })),
        },
        'shutdown.open_intents'
      )
    }

    scheduler?.stop()

    // F6-1: Close all open positions before tearing down WS/REST adapters.
    // flattenAll() cancels non-terminal intents and places market-close orders for open positions.
    await execManager.flattenAll()

    // Wait up to 8 seconds for market-close fills to arrive via WS before proceeding with teardown.
    // Market orders on liquid perpetuals typically fill in < 500ms.
    const FLATTEN_GRACE_MS = 8_000
    const flattenDeadline = Date.now() + FLATTEN_GRACE_MS
    while (Date.now() < flattenDeadline) {
      const stillOpen = execManager.list().filter(s => !['exited', 'error', 'cancelled'].includes(s.status))
      if (stillOpen.length === 0) break
      await new Promise<void>(r => setTimeout(r, 200))
    }

    positionMonitor.stop()
    execManager.stop()
    stateStore.stop()

    // Cancel any residual reduce-only orders left on exchanges after engine stops
    if (restAdapters.size > 0) {
      await Promise.allSettled(
        Array.from(restAdapters.entries()).map(async ([exchange, rest]) => {
          try {
            const open = await rest.getOpenOrders()
            const reduceOnly = open.filter(o => o.reduceOnly)
            const results = await Promise.allSettled(
              reduceOnly.map(o =>
                rest.cancelOrder({
                  symbol: o.symbol,
                  ...(o.clientOrderId ? { clientOrderId: o.clientOrderId } : {}),
                  ...(o.exchangeOrderId ? { exchangeOrderId: o.exchangeOrderId } : {}),
                })
              )
            )
            const failed = results.filter(r => r.status === 'rejected').length
            logger.info(
              { event: 'shutdown.sweep', exchange, cancelled: reduceOnly.length - failed, failed },
              'shutdown.sweep'
            )
          } catch (err) {
            logger.warn({ err, exchange }, 'shutdown.sweep failed')
          }
        })
      )
    }

    if (persistenceWriter) {
      try {
        persistenceWriter.stop()
        await persistenceWriter.flushAndWait()
      } catch (err) {
        logger.warn({ err }, 'error flushing persistence writer')
      }
    }
    if (dbHandle) {
      try {
        await dbHandle.close()
      } catch (err) {
        logger.warn({ err }, 'error closing db')
      }
    }
    for (const dispose of wsDisposers) {
      try {
        await dispose()
      } catch (err) {
        logger.warn({ err }, 'error disposing ws adapter')
      }
    }
    for (const dispose of adapterDisposers) {
      try {
        await dispose()
      } catch (err) {
        logger.warn({ err }, 'error disposing rest adapter')
      }
    }
    if (fundingSource) {
      try {
        await fundingSource.stop()
      } catch (err) {
        logger.warn({ err }, 'error stopping funding source')
      }
    }
    if (marketsHandle) {
      try {
        await marketsHandle.stop()
      } catch (err) {
        logger.warn({ err }, 'error stopping markets provider')
      }
    }
    try {
      await server.close()
    } catch (err) {
      logger.warn({ err }, 'error closing metrics server')
    }
    healthServer.setReady(false)
    try {
      await healthServer.close()
    } catch (err) {
      logger.warn({ err }, 'error closing health server')
    }
    logger.info({ event: 'engine.stopped' }, 'engine.stopped')
  }

  const base = { config, metricsPort: server.port, bus, stop, ...(runId ? { runId } : {}) }
  return {
    ...base,
    ...(marketsHandle ? { markets: marketsHandle.provider } : {}),
    ...(fundingSource ? { funding: fundingSource } : {}),
    ...(restAdapters.size > 0 ? { restAdapters, rateLimiters } : {}),
    state: stateStore,
    ...(wsAdapters.size > 0 ? { wsAdapters } : {}),
    manager: execManager,
    monitor: positionMonitor,
    strategies: strategyRegistry,
    ...(evaluator ? { evaluator } : {}),
    ...(scheduler ? { scheduler } : {}),
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string' },
      exchange: { type: 'string', multiple: true },
      symbol: { type: 'string', multiple: true },
      funding: { type: 'string' },
      'ack-live-funding-override': { type: 'boolean' },
      'metrics-port': { type: 'string' },
      'health-port': { type: 'string' },
    },
    allowPositionals: false,
  })

  if (!values.config) {
    console.error('error: --config <path> is required (e.g. --config config/execution.live.yaml)')
    process.exitCode = 1
    return
  }

  const opts: StartEngineOptions = { configPath: values.config }
  if (Array.isArray(values.exchange) && values.exchange.length > 0) {
    opts.exchangeFilter = values.exchange as Exchange[]
  }
  if (Array.isArray(values.symbol) && values.symbol.length > 0) {
    opts.symbolFilter = values.symbol
  }
  if (values.funding) opts.fundingTimeOverride = values.funding
  if (values['ack-live-funding-override']) opts.ackLiveFundingOverride = true
  if (values['metrics-port']) opts.metricsPort = parseInt(values['metrics-port'], 10)
  if (values['health-port']) opts.healthPort = parseInt(values['health-port'], 10)

  const handle = await startEngine(opts)

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    console.error(`received ${signal}, shutting down`)
    void handle
      .stop()
      .then(() => {
        process.exitCode = 0
      })
      .catch(() => {
        process.exitCode = 1
      })
  }
  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
}

const entry = process.argv[1] ?? ''
const isMainModule = import.meta.url === `file://${entry}` || entry.endsWith('src/execution/index.ts')

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('fatal', err)
    process.exitCode = 1
  })
}
