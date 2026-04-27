import { randomUUID } from 'node:crypto'
import { sql, eq, and } from 'drizzle-orm'
import type { Logger } from 'pino'

import type { EventBus } from '../core/types.js'
import type { PersistenceMetrics } from '../observability/metrics.js'
import type { IntentState } from '../execution/types.js'
import type { TradeIntent } from '../strategies/types.js'
import type { DrizzleDb } from './db.js'
import type { WalHandle, WalEntry } from './wal.js'
import {
  runs,
  tradeIntents,
  orders,
  opsEvents,
  positionsHistory,
  balancesHistory,
  fundingAttributions,
} from './drizzle/schema.js'

export interface PersistenceWriterOptions {
  db: DrizzleDb
  wal: WalHandle
  bus: EventBus
  runId: string
  logger: Logger
  metrics: PersistenceMetrics
  batchSize?: number
  flushIntervalMs?: number
}

export interface WriteOrderSyncParams {
  intentId: string
  clientOrderId: string
  exchange: string
  symbol: string
  side: 'buy' | 'sell'
  orderType: 'market' | 'limit' | 'stop_market'
  qty: number
  price?: number
  stopPrice?: number
  reduceOnly: boolean
}

export interface PersistenceWriterHandle {
  start(): void
  stop(): void
  flushAndWait(): Promise<void>
  /** Synchronous durability write: persists an order row directly to DB, bypassing the queue. */
  writeOrderSync(params: WriteOrderSyncParams): Promise<void>
  /**
   * Synchronous durability write: persists the intent row directly to DB, bypassing the queue.
   * Must be called before writeOrderSync so the FK constraint on orders.intent_id is satisfied.
   */
  writeIntentSync(intent: TradeIntent): Promise<void>
  /** Replay any pending WAL entries to DB immediately; used before runRecovery. */
  drainWalNow(): Promise<void>
}

interface QueuedWrite {
  table: string
  row: Record<string, unknown>
  onConflict?: 'ignore' | 'update'
}

const TERMINAL_ORDER_STATUSES = new Set(['filled', 'cancelled', 'rejected', 'expired'])

// Postgres error codes that indicate a permanent data/schema problem.
// These entries will never succeed on retry — discard them from the WAL rather than looping.
const PERMANENT_PG_ERROR_CODES = new Set([
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23505', // unique_violation (row already inserted)
  '23514', // check_violation
  '22001', // string_data_right_truncation
  '42703', // undefined_column
  '42P01', // undefined_table
])

/** Write a single row to the appropriate DB table. Exported for pre-recovery WAL drain. */
export async function writeRowToDb(
  db: DrizzleDb,
  table: string,
  row: Record<string, unknown>,
  onConflict?: 'ignore' | 'update'
): Promise<void> {
  switch (table) {
    case 'trade_intents':
      if (onConflict === 'ignore') {
        await db
          .insert(tradeIntents)
          .values(row as typeof tradeIntents.$inferInsert)
          .onConflictDoNothing()
      } else {
        await db
          .update(tradeIntents)
          .set({ status: sql`${row.status}::intent_status` })
          .where(eq(tradeIntents.id, row.id as string))
      }
      break

    case 'orders':
      if (onConflict === 'ignore') {
        await db
          .insert(orders)
          .values(row as typeof orders.$inferInsert)
          .onConflictDoNothing()
      } else {
        // UPSERT: insert or update exchangeOrderId on conflict (from order.placed event)
        await db
          .insert(orders)
          .values(row as typeof orders.$inferInsert)
          .onConflictDoUpdate({
            target: [orders.exchange, orders.clientOrderId],
            set: { exchangeOrderId: sql`EXCLUDED.exchange_order_id` },
          })
      }
      break

    case 'orders_status': {
      // UPDATE status + filledQty for an existing order (from ws.order events)
      const updateSet: Record<string, unknown> = {
        status: sql`${(row as { status: string }).status}::order_status`,
        filledQty: (row as { filledQty: string }).filledQty,
      }
      if (row.exchangeOrderId) updateSet.exchangeOrderId = row.exchangeOrderId
      if (row.ackedAt) updateSet.ackedAt = row.ackedAt
      if (row.terminalAt) updateSet.terminalAt = row.terminalAt
      await db
        .update(orders)
        .set(updateSet as Parameters<ReturnType<typeof db.update>['set']>[0])
        .where(
          and(
            eq(orders.exchange, (row as { exchange: string }).exchange),
            eq(orders.clientOrderId, (row as { clientOrderId: string }).clientOrderId)
          )
        )
      break
    }

    case 'positions_history':
      await db
        .insert(positionsHistory)
        .values(row as typeof positionsHistory.$inferInsert)
        .onConflictDoNothing()
      break

    case 'balances_history':
      await db
        .insert(balancesHistory)
        .values(row as typeof balancesHistory.$inferInsert)
        .onConflictDoNothing()
      break

    case 'funding_attributions':
      await db
        .insert(fundingAttributions)
        .values(row as typeof fundingAttributions.$inferInsert)
        .onConflictDoNothing()
      break

    case 'ops_events':
      await db
        .insert(opsEvents)
        .values(row as typeof opsEvents.$inferInsert)
        .onConflictDoNothing()
      break

    case 'runs':
      await db
        .insert(runs)
        .values(row as typeof runs.$inferInsert)
        .onConflictDoNothing()
      break

    default:
      // Unknown table — log but don't throw so the queue keeps draining
      break
  }
}

/** Drain all WAL entries to DB. Call before runRecovery to ensure DB state is current. */
export async function drainWalEntriesToDb(
  db: DrizzleDb,
  wal: WalHandle,
  logger: Logger
): Promise<void> {
  const entries = wal.peek()
  if (entries.length === 0) return
  logger.info({ count: entries.length }, 'wal: pre-recovery drain')

  const failed: WalEntry[] = []
  for (const entry of entries) {
    try {
      await writeRowToDb(db, entry.table, entry.row, entry.onConflict ?? 'ignore')
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code && PERMANENT_PG_ERROR_CODES.has(code)) {
        logger.warn({ code, table: entry.table }, 'wal: discarding entry with permanent schema error')
      } else {
        logger.warn({ err, table: entry.table }, 'wal: pre-recovery write failed, keeping entry')
        failed.push(entry)
      }
    }
  }
  wal.rewrite(failed)
}

export function createPersistenceWriter(opts: PersistenceWriterOptions): PersistenceWriterHandle {
  const { db, wal, bus, runId, logger, metrics, batchSize = 100, flushIntervalMs = 250 } = opts

  const queue: QueuedWrite[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined
  const unsubs: (() => void)[] = []

  function enqueue(write: QueuedWrite): void {
    if (queue.length >= 1000) {
      metrics.droppedTotal.inc(1, { reason: 'overflow' })
      logger.error({ table: write.table, queueSize: queue.length }, 'persistence: queue overflow, dropping write')
      return
    }
    queue.push(write)
    metrics.queueSize.set(queue.length)
  }

  function intentStateToRow(state: IntentState): Record<string, unknown> {
    const { intent } = state
    return {
      id: intent.id,
      runId,
      strategy: intent.strategy,
      exchange: intent.exchange,
      symbol: intent.symbol,
      exchangeSymbol: intent.exchangeSymbol,
      side: intent.side,
      amountUsd: String(intent.amountUsd),
      leverage: intent.leverage,
      fundingRate: String(intent.fundingRate),
      fundingRatePercent: String(intent.fundingRatePercent),
      fundingInterval: typeof intent.fundingInterval === 'string' ? parseInt(intent.fundingInterval, 10) : intent.fundingInterval,
      nextFundingTs: new Date(intent.nextFundingTimestamp),
      decidedAt: new Date(intent.decidedAt),
      entryAt: new Date(intent.entryAt),
      status: state.status,
      exitPolicy: intent.exitPolicy,
      fundingSnapshot: {
        exchange: intent.exchange,
        symbol: intent.symbol,
        fundingRate: intent.fundingRate,
        fundingRatePercent: intent.fundingRatePercent,
        fundingInterval: intent.fundingInterval,
        nextFundingTimestamp: intent.nextFundingTimestamp,
        nextFundingDatetime: intent.nextFundingDatetime,
      },
    }
  }

  async function writeRow(table: string, write: QueuedWrite): Promise<void> {
    try {
      await writeRowToDb(db, table, write.row, write.onConflict)
      metrics.writesTotal.inc(1, { table, result: 'success' })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === '23505') {
        metrics.writesTotal.inc(1, { table, result: 'conflict' })
      } else {
        throw err
      }
    }
  }

  function subscribeAll(): void {
    unsubs.push(
      bus.on('intent.decided', intent => {
        const state: IntentState = {
          intent,
          status: 'decided',
          filledQty: 0,
          updatedAt: Date.now(),
        }
        enqueue({ table: 'trade_intents', row: intentStateToRow(state), onConflict: 'ignore' })
      })
    )

    unsubs.push(
      bus.on('intent.state_changed', state => {
        enqueue({
          table: 'trade_intents',
          row: { id: state.intent.id, status: state.status },
          onConflict: 'update',
        })
      })
    )

    // Write order rows immediately (fire-and-forget, not queued) since the order is
    // already live on the exchange by the time order.placed fires. A durability-point
    // write via beforeCreateOrder may have already inserted the row; this upsert adds
    // the exchangeOrderId from the ACK if it was missing.
    unsubs.push(
      bus.on('order.placed', event => {
        const row: Record<string, unknown> = {
          id: randomUUID(),
          intentId: event.intentId,
          exchange: event.exchange,
          symbol: event.symbol,
          clientOrderId: event.clientOrderId,
          exchangeOrderId: event.exchangeOrderId ?? null,
          side: event.side,
          type: event.orderType,
          reduceOnly: event.reduceOnly,
          qty: String(event.qty),
          filledQty: '0',
          price: event.price != null ? String(event.price) : null,
          status: 'new',
          submittedAt: new Date(),
        }
        // Use 'update' so the UPSERT sets exchangeOrderId if the durability write already
        // inserted this row without it. onConflictDoUpdate only sets exchangeOrderId.
        void writeRow('orders', { table: 'orders', row, onConflict: 'update' }).catch((err: unknown) => {
          logger.warn({ err, clientOrderId: event.clientOrderId }, 'persistence: order write failed, buffering to WAL')
          wal.append({ table: 'orders', row, onConflict: 'update' })
          metrics.writesTotal.inc(1, { table: 'orders', result: 'wal_fallback' })
        })
      })
    )

    // Track order status and filledQty changes from the WS stream.
    unsubs.push(
      bus.on('ws.order', event => {
        const { order } = event
        const row: Record<string, unknown> = {
          exchange: event.exchange,
          clientOrderId: order.clientOrderId,
          exchangeOrderId: order.exchangeOrderId || null,
          status: order.status,
          filledQty: String(order.filledQty),
          ...(order.status !== 'new' ? { ackedAt: new Date(order.submittedAt) } : {}),
          ...(TERMINAL_ORDER_STATUSES.has(order.status) ? { terminalAt: new Date(order.updatedAt) } : {}),
        }
        enqueue({ table: 'orders_status', row })
      })
    )

    unsubs.push(
      bus.on('ws.position', event => {
        const { position } = event
        if (Math.abs(position.qty) < 1e-9) return
        enqueue({
          table: 'positions_history',
          row: {
            id: randomUUID(),
            exchange: event.exchange,
            symbol: position.symbol,
            qty: String(position.qty),
            entryPrice: position.entryPrice != null ? String(position.entryPrice) : null,
            markPrice: position.markPrice != null ? String(position.markPrice) : null,
            leverage: position.leverage,
            snapshotReason: 'periodic',
            ts: new Date(position.updatedAt),
          },
          onConflict: 'ignore',
        })
      })
    )

    unsubs.push(
      bus.on('ws.balance', event => {
        const { balance } = event
        enqueue({
          table: 'balances_history',
          row: {
            id: randomUUID(),
            exchange: event.exchange,
            asset: balance.asset,
            available: String(balance.available),
            locked: String(balance.locked),
            ts: new Date(balance.updatedAt),
          },
          onConflict: 'ignore',
        })
      })
    )

    unsubs.push(
      bus.on('ws.funding_fee', event => {
        enqueue({
          table: 'funding_attributions',
          row: {
            id: randomUUID(),
            exchange: event.exchange,
            symbol: event.symbol,
            positionId: null,
            fundingTime: new Date(event.fundingTime),
            fundingRate: String(event.fundingRate),
            fundingAmount: String(event.fundingAmount),
            asset: event.asset,
            ts: new Date(),
          },
          onConflict: 'ignore',
        })
      })
    )

    unsubs.push(
      bus.on('state.desync', event => {
        enqueue({
          table: 'ops_events',
          row: {
            id: randomUUID(),
            ts: new Date(event.detectedAt),
            level: 'warn',
            exchange: event.exchange,
            eventType: `state.desync.${event.kind}`,
            payload: JSON.stringify(event.details),
          },
          onConflict: 'ignore',
        })
      })
    )

    unsubs.push(
      bus.on('ops.event', event => {
        enqueue({
          table: 'ops_events',
          row: {
            id: randomUUID(),
            ts: new Date(event.ts),
            level: event.level,
            exchange: event.exchange ?? null,
            eventType: event.eventType,
            payload: JSON.stringify(event.payload),
          },
          onConflict: 'ignore',
        })
      })
    )
  }

  async function flushBatch(batch: QueuedWrite[]): Promise<void> {
    const start = Date.now()
    let errorCount = 0
    for (const write of batch) {
      try {
        await writeRow(write.table, write)
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code && PERMANENT_PG_ERROR_CODES.has(code)) {
          logger.warn({ code, table: write.table }, 'persistence: discarding write with permanent schema error')
          metrics.writesTotal.inc(1, { table: write.table, result: 'discarded' })
        } else {
          logger.warn({ err, table: write.table }, 'persistence: write failed, buffering to WAL')
          wal.append({ table: write.table, row: write.row, ...(write.onConflict !== undefined ? { onConflict: write.onConflict } : {}) })
          errorCount++
          metrics.writesTotal.inc(1, { table: write.table, result: 'error' })
        }
      }
    }
    if (errorCount === 0) {
      metrics.writesTotal.inc(batch.length, { table: 'batch', result: 'success' })
    }
    metrics.flushDurationMs.observe(Date.now() - start)
  }

  async function drainQueue(): Promise<void> {
    if (queue.length === 0) return
    const batch = queue.splice(0, batchSize)
    metrics.queueSize.set(queue.length)
    await flushBatch(batch)
  }

  async function drainWal(): Promise<void> {
    const entries = wal.peek()
    if (entries.length === 0) return
    logger.info({ count: entries.length }, 'persistence: draining WAL')

    const failed: typeof entries = []
    for (const entry of entries) {
      try {
        await writeRow(entry.table, { table: entry.table, row: entry.row, onConflict: entry.onConflict ?? 'ignore' })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code && PERMANENT_PG_ERROR_CODES.has(code)) {
          logger.warn({ code, table: entry.table }, 'persistence: WAL discarding entry with permanent schema error')
          metrics.writesTotal.inc(1, { table: entry.table, result: 'discarded' })
        } else {
          logger.warn({ err, table: entry.table }, 'persistence: WAL write failed, keeping entry')
          failed.push(entry)
          metrics.writesTotal.inc(1, { table: entry.table, result: 'error' })
        }
      }
    }
    wal.rewrite(failed)
  }

  return {
    start(): void {
      subscribeAll()
      flushTimer = setInterval(() => {
        void drainQueue()
        void drainWal()
      }, flushIntervalMs)
    },

    stop(): void {
      if (flushTimer) clearInterval(flushTimer)
      for (const u of unsubs) u()
    },

    async flushAndWait(): Promise<void> {
      if (flushTimer) clearInterval(flushTimer)
      while (queue.length > 0) {
        await drainQueue()
      }
      await drainWal()
    },

    async writeOrderSync(params: WriteOrderSyncParams): Promise<void> {
      const row: typeof orders.$inferInsert = {
        id: randomUUID(),
        intentId: params.intentId,
        exchange: params.exchange,
        symbol: params.symbol,
        clientOrderId: params.clientOrderId,
        exchangeOrderId: null,
        side: params.side,
        type: params.orderType,
        reduceOnly: params.reduceOnly,
        qty: String(params.qty),
        filledQty: '0',
        price: params.price != null ? String(params.price) : null,
        status: 'new',
        submittedAt: new Date(),
      }
      try {
        await db.insert(orders).values(row).onConflictDoNothing()
        metrics.writesTotal.inc(1, { table: 'orders', result: 'sync_success' })
      } catch (err) {
        logger.warn({ err, clientOrderId: params.clientOrderId }, 'persistence: sync order write failed, buffering to WAL')
        wal.append({ table: 'orders', row: row as unknown as Record<string, unknown>, onConflict: 'ignore' })
        metrics.writesTotal.inc(1, { table: 'orders', result: 'wal_fallback' })
      }
    },

    async writeIntentSync(intent: TradeIntent): Promise<void> {
      const state: IntentState = {
        intent,
        status: 'decided',
        filledQty: 0,
        updatedAt: Date.now(),
      }
      const row = intentStateToRow(state)
      try {
        await db.insert(tradeIntents).values(row as typeof tradeIntents.$inferInsert).onConflictDoNothing()
        metrics.writesTotal.inc(1, { table: 'trade_intents', result: 'sync_success' })
      } catch (err) {
        logger.warn({ err, intentId: intent.id }, 'persistence: sync intent write failed, buffering to WAL')
        wal.append({ table: 'trade_intents', row, onConflict: 'ignore' })
        metrics.writesTotal.inc(1, { table: 'trade_intents', result: 'wal_fallback' })
      }
    },

    async drainWalNow(): Promise<void> {
      await drainWal()
    },
  }
}
