import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'

import type { EngineConfig } from '../config/types.js'
import type { EventBus } from '../core/types.js'
import type { ExchangeRestAdapter, OrderSide } from '../adapters/rest/types.js'
import type { Exchange } from '../types/exchange.js'
import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import type { IntentState, IntentStatus } from '../execution/types.js'
import type { TradeIntent, ExitPolicy } from '../strategies/types.js'
import type { ExecutionManagerInitialState } from '../execution/manager.js'
import type { PersistenceMetrics } from '../observability/metrics.js'
import type { DrizzleDb } from '../persistence/db.js'
import type { TradeIntentRow, OrderRow } from '../persistence/queries.js'
import {
  findLatestOpenRun,
  insertRun,
  updateRunNotes,
  loadActiveIntents,
  loadOrdersForIntents,
} from '../persistence/queries.js'
import { runs } from '../persistence/drizzle/schema.js'
import { eq } from 'drizzle-orm'

const ACTIVE_STATUSES = new Set<IntentStatus>([
  'decided',
  'submitted',
  'acked',
  'working',
  'partially_filled',
  'filled',
  'monitoring',
  'exiting',
])

export interface RecoveryOptions {
  db: DrizzleDb
  config: EngineConfig
  bus: EventBus
  restAdapters: Map<Exchange, ExchangeRestAdapter>
  logger: Logger
  metrics: PersistenceMetrics
  resumeRunId?: string
  /** If true, throw when any exchange REST fetch fails during orphan check (default: false). */
  failOnExchangeError?: boolean
}

export interface RecoveryResult {
  runId: string
  initialState: ExecutionManagerInitialState
  rehydratedCount: number
  orphansCancelled: number
  orphansFlattened: number
}

function rowToTradeIntent(row: TradeIntentRow): TradeIntent {
  // Reconstruct exitPolicy from the persisted JSONB. Fall back to a timed exit for
  // rows written before migration 0001 (exitPolicy column defaulted to '{}').
  const storedPolicy = row.exitPolicy as ExitPolicy | Record<string, never> | null
  const exitPolicy: ExitPolicy =
    storedPolicy && 'kind' in storedPolicy && storedPolicy.kind
      ? (storedPolicy as ExitPolicy)
      : { kind: 'timed', exitAt: row.decidedAt.getTime() + 3600_000 }

  return {
    id: row.id,
    strategy: row.strategy as TradeIntent['strategy'],
    exchange: row.exchange as Exchange,
    symbol: row.symbol,
    // exchangeSymbol was added in migration 0001; fall back to symbol for old rows.
    exchangeSymbol: row.exchangeSymbol || row.symbol,
    side: row.side as 'long' | 'short',
    amountUsd: parseFloat(row.amountUsd),
    leverage: row.leverage,
    volume: 0,
    fundingRate: parseFloat(row.fundingRate),
    fundingRatePercent: parseFloat(row.fundingRatePercent),
    fundingInterval: row.fundingInterval as 1 | 2 | 4 | 8,
    nextFundingTimestamp: row.nextFundingTs.getTime(),
    nextFundingDatetime: row.nextFundingTs.toISOString(),
    decidedAt: row.decidedAt.getTime(),
    entryAt: row.entryAt ? row.entryAt.getTime() : row.decidedAt.getTime(),
    exitPolicy,
  }
}

export async function runRecovery(opts: RecoveryOptions): Promise<RecoveryResult> {
  const { db, config, bus, restAdapters, logger, metrics } = opts
  const now = Date.now()

  let runId: string
  let isResume = false

  if (opts.resumeRunId) {
    const existing = await db.select().from(runs).where(eq(runs.id, opts.resumeRunId)).limit(1)
    if (existing[0]) {
      runId = opts.resumeRunId
      isResume = true
      logger.info({ runId }, 'recovery: resuming existing run')
    } else {
      logger.warn({ resumeRunId: opts.resumeRunId }, 'recovery: resume run not found, starting new')
      runId = randomUUID()
    }
  } else {
    const openRun = await findLatestOpenRun(db)
    if (openRun) {
      runId = openRun.id
      isResume = true
      logger.info({ runId }, 'recovery: found open run, resuming')
    } else {
      runId = randomUUID()
    }
  }

  if (!isResume) {
    await insertRun(db, {
      id: runId,
      startedAt: new Date(now),
      mode: config.mode,
      configHash: config.configHash,
      gitSha: config.gitSha,
    })
    logger.info({ runId }, 'recovery: started new run')
  }

  const intentStates = new Map<string, IntentState>()
  const byEntryOrderId = new Map<string, string>()
  const byEntryExchangeOrderId = new Map<string, string>()
  const byCloseOrderId = new Map<string, string>()
  const byCloseExchangeOrderId = new Map<string, string>()

  let rehydratedCount = 0
  let orphansCancelled = 0
  let orphansFlattened = 0

  if (isResume) {
    const intentRows = await loadActiveIntents(db, runId)
    rehydratedCount = intentRows.length

    const orderRows = await loadOrdersForIntents(
      db,
      intentRows.map(r => r.id)
    )
    const ordersByIntent = new Map<string, OrderRow[]>()
    for (const o of orderRows) {
      const arr = ordersByIntent.get(o.intentId) ?? []
      arr.push(o)
      ordersByIntent.set(o.intentId, arr)
    }

    for (const intentRow of intentRows) {
      const intent = rowToTradeIntent(intentRow)
      const intentOrders = ordersByIntent.get(intentRow.id) ?? []

      const entryOrder = intentOrders.find(o => !o.reduceOnly)
      const exitOrders = intentOrders.filter(o => o.reduceOnly)

      // Reconstruct filledQty from the entry order row. If the engine was killed while
      // the entry was partially or fully filled, the ws.order handler will have updated
      // filled_qty in the DB via the periodic flush.
      const filledQty = entryOrder ? parseFloat(entryOrder.filledQty ?? '0') : 0

      const state: IntentState = {
        intent,
        status: intentRow.status as IntentStatus,
        filledQty,
        updatedAt: now,
      }

      if (entryOrder) {
        state.entryOrderId = entryOrder.clientOrderId
        byEntryOrderId.set(entryOrder.clientOrderId, intent.id)
        if (entryOrder.exchangeOrderId) {
          byEntryExchangeOrderId.set(entryOrder.exchangeOrderId, intent.id)
          state.entryExchangeOrderId = entryOrder.exchangeOrderId
        }
      }

      if (exitOrders.length > 0) {
        // Convention: [0]=SL (stop_market), [1]=TP (limit).
        const sortedExitOrders = [...exitOrders].sort((a, b) => {
          if (a.type === 'stop_market') return -1
          if (b.type === 'stop_market') return 1
          return 0
        })
        state.exitOrderIds = sortedExitOrders.map(o => o.clientOrderId)
        for (const o of exitOrders) {
          byCloseOrderId.set(o.clientOrderId, intent.id)
          if (o.exchangeOrderId) {
            byCloseExchangeOrderId.set(o.exchangeOrderId, intent.id)
          }
        }
      }

      intentStates.set(intent.id, state)
    }

    logger.info({ rehydratedCount }, 'recovery: rehydrated intent states')
  }

  const rehydratedClientOrderIds = new Set([...byEntryOrderId.keys(), ...byCloseOrderId.keys()])

  for (const [exchange, rest] of restAdapters) {
    let restOrders: Awaited<ReturnType<typeof rest.getOpenOrders>>
    let restPositions: Awaited<ReturnType<typeof rest.getPositions>>

    try {
      ;[restOrders, restPositions] = await Promise.all([rest.getOpenOrders(), rest.getPositions()])
    } catch (err) {
      logger.error({ err, exchange }, 'recovery: REST fetch failed — orphan check skipped for this exchange')
      bus.emit('ops.event', {
        ts: Date.now(),
        level: 'error',
        exchange,
        eventType: 'recovery.exchange_fetch_failed',
        payload: { error: String(err) },
      })
      if (opts.failOnExchangeError) {
        throw new Error(`recovery: REST fetch failed for ${exchange}: ${String(err)}`)
      }
      continue
    }

    for (const order of restOrders) {
      if (!rehydratedClientOrderIds.has(order.clientOrderId)) {
        logger.warn(
          { exchange, clientOrderId: order.clientOrderId },
          'recovery: orphan order found, cancelling'
        )
        try {
          await rest.cancelOrder({ symbol: order.symbol, clientOrderId: order.clientOrderId })
          orphansCancelled++
          metrics.orphansCancelledTotal.inc(1, { exchange })
          bus.emit('ops.event', {
            ts: Date.now(),
            level: 'warn',
            exchange,
            eventType: 'orphan_order_cancelled',
            payload: { clientOrderId: order.clientOrderId, symbol: order.symbol },
          })
        } catch (err) {
          logger.warn({ err, exchange, clientOrderId: order.clientOrderId }, 'recovery: cancel orphan failed')
        }
      }
    }

    // Build set of both internal (normalized) and exchange symbols so that positions
    // returned by the REST adapter (which may use CCXT unified format like "SPELL/USDT:USDT")
    // are correctly matched against rehydrated intents whose symbol is normalized ("SPELLUSDT").
    const rehydratedSymbols = new Set(
      Array.from(intentStates.values())
        .filter(s => s.intent.exchange === exchange && ACTIVE_STATUSES.has(s.status))
        .flatMap(s => [s.intent.symbol, s.intent.exchangeSymbol])
    )

    for (const position of restPositions) {
      if (position.qty < 1e-9) continue
      // position.symbol from CCXT is unified format ("SPELL/USDT:USDT"); normalize it
      // to match against the internal symbol ("SPELLUSDT") in the rehydrated set.
      if (rehydratedSymbols.has(position.symbol)) continue
      if (rehydratedSymbols.has(normalizeSymbol(position.symbol))) continue

      logger.warn(
        { exchange, symbol: position.symbol, qty: position.qty },
        'recovery: orphan position found, flattening'
      )
      try {
        const closeSide: OrderSide = position.side === 'long' ? 'sell' : 'buy'
        // Use a UUID to avoid clientOrderId truncation issues with long exchange+symbol names.
        await rest.createOrder({
          intentId: 'recovery-flatten',
          clientOrderId: `rcv-${randomUUID().replace(/-/g, '').slice(0, 28)}`,
          exchange,
          symbol: position.symbol,
          side: closeSide,
          type: 'market',
          qty: position.qty,
          reduceOnly: true,
        })
        orphansFlattened++
        metrics.orphansFlattenedTotal.inc(1, { exchange })
        bus.emit('ops.event', {
          ts: Date.now(),
          level: 'warn',
          exchange,
          eventType: 'orphan_position_flattened',
          payload: { symbol: position.symbol, qty: position.qty },
        })
      } catch (err) {
        logger.error({ err, exchange, symbol: position.symbol }, 'recovery: flatten orphan failed')
      }
    }
  }

  const notes = JSON.stringify({
    rehydratedCount,
    orphansCancelled,
    orphansFlattened,
    recoveredAt: new Date(now).toISOString(),
  })
  await updateRunNotes(db, runId, notes)

  return {
    runId,
    initialState: {
      intentStates,
      byEntryOrderId,
      byEntryExchangeOrderId,
      byCloseOrderId,
      byCloseExchangeOrderId,
    },
    rehydratedCount,
    orphansCancelled,
    orphansFlattened,
  }
}
