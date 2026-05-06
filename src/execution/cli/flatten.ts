/**
 * Emergency flatten CLI — cancels all open orders and closes all open positions across all
 * configured exchanges. Designed to run against a live engine config even when the engine
 * process itself is dead (uses REST adapters directly, no running engine required).
 *
 * Usage:
 *   npx tsx src/execution/cli/flatten.ts --config config/execution.live.yaml
 *   npx tsx src/execution/cli/flatten.ts --config config/execution.live.yaml --exchange binance
 *   npx tsx src/execution/cli/flatten.ts --config config/execution.live.yaml --dry-run
 */
import { parseArgs } from 'node:util'
import { config } from 'dotenv'
config()

import pino from 'pino'

import { loadEngineConfig } from '../config/loader.js'
import type { ExchangeConfig } from '../config/types.js'
import { createClock } from '../core/clock.js'
import { createIds } from '../core/ids.js'
import type { RateLimiter } from '../core/types.js'
import { createEventBus } from '../core/bus.js'
import { createRestAdapter } from '../adapters/rest/factory.js'
import type { Exchange } from '../types/exchange.js'
import { MetricsRegistry, registerRestMetrics } from '../observability/metrics.js'
import { createNoopTracer } from '../observability/tracing.js'

function createPassthroughRateLimiter(): RateLimiter {
  return {
    acquire: () => Promise.resolve(),
    reserve: () => () => {
      /* noop */
    },
  }
}

const logger = pino({ level: 'info' })

async function flattenExchange(cfg: ExchangeConfig, dryRun: boolean): Promise<void> {
  const clock = createClock()
  const ids = createIds()
  const bus = createEventBus()
  const registry = new MetricsRegistry()
  const metrics = registerRestMetrics(registry)
  const limiter = createPassthroughRateLimiter()

  const adapter = createRestAdapter({
    engineMode: dryRun ? 'dry_run' : 'live',
    config: cfg,
    limiter,
    clock,
    ids,
    logger: logger.child({ exchange: cfg.exchange }),
    metrics,
    bus,
    tracer: createNoopTracer(),
  })

  const exchange = cfg.exchange

  logger.info({ exchange, dryRun }, 'flatten: starting')

  // 1. Cancel all open orders
  let openOrders: Awaited<ReturnType<typeof adapter.getOpenOrders>> = []
  try {
    openOrders = await adapter.getOpenOrders()
    logger.info({ exchange, count: openOrders.length }, 'flatten: open orders fetched')
  } catch (err) {
    logger.error({ exchange, err }, 'flatten: failed to fetch open orders')
  }

  for (const order of openOrders) {
    if (dryRun) {
      logger.info(
        { exchange, clientOrderId: order.clientOrderId, symbol: order.symbol },
        'flatten: [dry-run] would cancel order'
      )
      continue
    }
    try {
      await adapter.cancelOrder({
        symbol: order.symbol,
        ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
        ...(order.exchangeOrderId ? { exchangeOrderId: order.exchangeOrderId } : {}),
      })
      logger.info({ exchange, clientOrderId: order.clientOrderId, symbol: order.symbol }, 'flatten: order cancelled')
    } catch (err) {
      logger.warn({ exchange, clientOrderId: order.clientOrderId, err }, 'flatten: cancel failed')
    }
  }

  // 2. Close all open positions
  let positions: Awaited<ReturnType<typeof adapter.getPositions>> = []
  try {
    positions = await adapter.getPositions()
    const open = positions.filter(p => p.qty > 0)
    logger.info({ exchange, total: positions.length, open: open.length }, 'flatten: positions fetched')
    positions = open
  } catch (err) {
    logger.error({ exchange, err }, 'flatten: failed to fetch positions')
    return
  }

  for (const pos of positions) {
    const closeSide = pos.side === 'long' ? 'sell' : 'buy'
    if (dryRun) {
      logger.info(
        { exchange, symbol: pos.symbol, side: pos.side, qty: pos.qty },
        'flatten: [dry-run] would close position'
      )
      continue
    }
    try {
      const closeId = `flat-${exchange}-${pos.symbol}-${String(Date.now())}`.slice(0, 32)
      const ack = await adapter.createOrder({
        intentId: 'flatten-cli',
        clientOrderId: closeId,
        exchange,
        symbol: pos.symbol,
        side: closeSide,
        type: 'market',
        qty: pos.qty,
        reduceOnly: true,
      })
      logger.info({ exchange, symbol: pos.symbol, qty: pos.qty, ack }, 'flatten: position close submitted')
    } catch (err) {
      logger.error({ exchange, symbol: pos.symbol, err }, 'flatten: position close failed')
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string' },
      exchange: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (!values.config) {
    console.error('error: --config <path> is required (e.g. --config config/execution.live.yaml)')
    process.exitCode = 1
    return
  }

  const engineConfig = loadEngineConfig({ configPath: values.config })
  const dryRun = values['dry-run']

  const exchangeFilter = values.exchange as Exchange[] | undefined
  const exchanges = engineConfig.exchanges.filter(
    e =>
      e.enabled && (exchangeFilter === undefined || exchangeFilter.length === 0 || exchangeFilter.includes(e.exchange))
  )

  if (exchanges.length === 0) {
    logger.warn('flatten: no enabled exchanges match the filter')
    return
  }

  logger.info({ exchanges: exchanges.map(e => e.exchange), dryRun }, 'flatten: starting across exchanges')

  for (const cfg of exchanges) {
    try {
      await flattenExchange(cfg, dryRun)
    } catch (err) {
      logger.error({ exchange: cfg.exchange, err }, 'flatten: exchange failed')
    }
  }

  logger.info('flatten: done')
}

main().catch((err: unknown) => {
  console.error('flatten error:', err)
  process.exitCode = 1
})
