import { randomUUID } from 'node:crypto'
import { sql, eq, and, gte, lte, or, isNull } from 'drizzle-orm'
import type { Logger } from 'pino'

import type { EventBus, IntentExitedEvent } from '../core/types.js'
import type { PersistenceMetrics } from '../observability/metrics.js'
import type { IntentState } from '../execution/types.js'
import type { TradeIntent } from '../strategies/types.js'
import type { EngineIdentity } from '../config/types.js'
import type { DrizzleDb } from './db.js'
import type { WalHandle, WalEntry } from './wal.js'
import {
  runs,
  tradeIntents,
  orders,
  fills,
  fillsDeadLetter,
  balancesHistory,
  fundingAttributions,
  opsEvents,
  intentLifecycleEvents,
  exitTriggers,
  realizedPnl,
} from './drizzle/schema.js'
import { logFillUnmatched, logWalDiscarded } from '../observability/log-events.js'

export interface PersistenceWriterOptions {
  db: DrizzleDb
  wal: WalHandle
  bus: EventBus
  runId: string
  logger: Logger
  metrics: PersistenceMetrics
  batchSize?: number
  flushIntervalMs?: number
  identity?: EngineIdentity
}

export interface WriteOrderSyncParams {
  intentId: string
  clientOrderId: string
  exchange: string
  symbol: string
  side: 'buy' | 'sell'
  orderType: 'market' | 'limit' | 'stop_market'
  kind: 'entry' | 'pre_funding' | 'sl' | 'tp' | 'close' | 'timed'
  qty: number
  price?: number
  stopPrice?: number
  intendedPrice?: number
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
  '22007', // invalid_datetime_format (e.g. out-of-range extended-year timestamp)
  '22008', // datetime_field_overflow
  '42703', // undefined_column
  '42P01', // undefined_table
])

/** Convert a numeric value to a finite string, or null for NaN/undefined/Infinity. */
function toFiniteStr(v: number | undefined | null): string | null {
  if (v == null || !isFinite(v)) return null
  return String(v)
}

/** Coerce a WAL-replayed timestamp (ISO string or number) back to a Date. */
function toDate(v: unknown): Date {
  if (v instanceof Date) return v
  const n = typeof v === 'number' ? v : Number(v)
  // Bybit WS sends microsecond timestamps (16 digits); convert to ms
  const ms = !isNaN(n) && n > 9_999_999_999_999 ? Math.floor(n / 1000) : n
  return isNaN(ms) ? new Date(v as string) : new Date(ms)
}

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
        const tiRow = {
          ...row,
          ...(row.nextFundingTs ? { nextFundingTs: toDate(row.nextFundingTs) } : {}),
          ...(row.decidedAt ? { decidedAt: toDate(row.decidedAt) } : {}),
          ...(row.entryAt ? { entryAt: toDate(row.entryAt) } : {}),
        }
        await db
          .insert(tradeIntents)
          .values(tiRow as typeof tradeIntents.$inferInsert)
          .onConflictDoNothing()
      } else {
        const updateSet: Record<string, unknown> = {}
        if (row.status) updateSet.status = sql`${row.status}::intent_status`
        if (row.exitAt) updateSet.exitAt = toDate(row.exitAt)
        if (row.exitReason) updateSet.exitReason = row.exitReason
        if (row.avgEntryPrice) updateSet.avgEntryPrice = row.avgEntryPrice
        if (row.avgExitPrice) updateSet.avgExitPrice = row.avgExitPrice
        if (row.entryFilledAt) updateSet.entryFilledAt = toDate(row.entryFilledAt)
        if (row.exitFilledAt) updateSet.exitFilledAt = toDate(row.exitFilledAt)
        if (row.fundingGateOpen !== undefined) updateSet.fundingGateOpen = row.fundingGateOpen
        await db
          .update(tradeIntents)
          .set(updateSet as Parameters<ReturnType<typeof db.update>['set']>[0])
          .where(eq(tradeIntents.id, row.id as string))
      }
      break

    case 'orders': {
      const ordersRow = { ...row, ...(row.submittedAt ? { submittedAt: toDate(row.submittedAt) } : {}) }
      if (onConflict === 'ignore') {
        await db
          .insert(orders)
          .values(ordersRow as typeof orders.$inferInsert)
          .onConflictDoNothing()
      } else {
        // UPSERT: insert or update exchangeOrderId on conflict (from order.placed event)
        await db
          .insert(orders)
          .values(ordersRow as typeof orders.$inferInsert)
          .onConflictDoUpdate({
            target: [orders.exchange, orders.clientOrderId],
            set: { exchangeOrderId: sql`EXCLUDED.exchange_order_id` },
          })
      }
      break
    }

    case 'orders_status': {
      // UPDATE status + filledQty for an existing order (from ws.order events)
      const updateSet: Record<string, unknown> = {
        status: sql`${(row as { status: string }).status}::order_status`,
        filledQty: sql`GREATEST(orders.filled_qty::numeric, ${(row as { filledQty: string }).filledQty}::numeric)`,
      }
      if (row.exchangeOrderId) updateSet.exchangeOrderId = row.exchangeOrderId
      if (row.ackedAt) updateSet.ackedAt = toDate(row.ackedAt)
      if (row.terminalAt) updateSet.terminalAt = toDate(row.terminalAt)
      if (row.firstFillAt) updateSet.firstFillAt = sql`COALESCE(orders.first_fill_at, ${toDate(row.firstFillAt)})`
      if (row.workingAt) updateSet.workingAt = sql`COALESCE(orders.working_at, ${toDate(row.workingAt)})`
      const exchange = (row as { exchange: string }).exchange
      const clientOrderId = (row as { clientOrderId: string }).clientOrderId
      const exchangeOrderId = row.exchangeOrderId as string | null | undefined
      // Primary: match by clientOrderId. Fallback to exchangeOrderId when CCXT broker-prefixes
      // the clientOrderId before submission (e.g. Binance adds 'x-r1wQQsTn' prefix), causing the
      // REST/WS response clientOrderId to differ from what we stored.
      const whereClause = exchangeOrderId
        ? and(eq(orders.exchange, exchange), or(eq(orders.clientOrderId, clientOrderId), eq(orders.exchangeOrderId, exchangeOrderId)))
        : and(eq(orders.exchange, exchange), eq(orders.clientOrderId, clientOrderId))
      await db
        .update(orders)
        .set(updateSet as Parameters<ReturnType<typeof db.update>['set']>[0])
        .where(whereClause)
      break
    }

    case 'fills':
      await db
        .insert(fills)
        .values({ ...row, ts: toDate(row.ts) } as typeof fills.$inferInsert)
        .onConflictDoNothing()
      break

    case 'fills_dead_letter':
      await db
        .insert(fillsDeadLetter)
        .values({ ...row, ts: toDate(row.ts) } as typeof fillsDeadLetter.$inferInsert)
      break

    case 'balances_history':
      await db
        .insert(balancesHistory)
        .values({ ...row, ts: toDate(row.ts) } as typeof balancesHistory.$inferInsert)
        .onConflictDoNothing()
      break

    case 'funding_attributions':
      await db
        .insert(fundingAttributions)
        .values({ ...row, fundingTime: toDate(row.fundingTime), ts: toDate(row.ts) } as typeof fundingAttributions.$inferInsert)
        .onConflictDoNothing()
      break

    case 'ops_events':
      await db
        .insert(opsEvents)
        .values({ ...row, ts: toDate(row.ts) } as typeof opsEvents.$inferInsert)
        .onConflictDoNothing()
      break

    case 'runs':
      await db
        .insert(runs)
        .values(row as typeof runs.$inferInsert)
        .onConflictDoNothing()
      break

    case 'intent_lifecycle_events':
      await db
        .insert(intentLifecycleEvents)
        .values({ ...row, ts: toDate(row.ts) } as typeof intentLifecycleEvents.$inferInsert)
        .onConflictDoNothing()
      break

    case 'exit_triggers':
      await db
        .insert(exitTriggers)
        .values({ ...row, triggerTs: toDate(row.triggerTs) } as typeof exitTriggers.$inferInsert)
        .onConflictDoNothing()
      break

    case 'realized_pnl':
      await db
        .insert(realizedPnl)
        .values({ ...row, computedAt: toDate(row.computedAt) } as typeof realizedPnl.$inferInsert)
        .onConflictDoNothing()
      break

    default:
      // Unknown table — log but don't throw so the queue keeps draining
      break
  }
}

/** Drain all WAL entries to DB. Call before runRecovery to ensure DB state is current. */
export async function drainWalEntriesToDb(db: DrizzleDb, wal: WalHandle, logger: Logger): Promise<void> {
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
        logWalDiscarded(logger, {
          table: entry.table,
          pgErrorCode: code,
          pgErrorText: (err as Error).message || String(err),
        })
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
  const { db, wal, bus, runId, logger, metrics, batchSize = 100, flushIntervalMs = 250, identity } = opts

  if (!identity && process.env.NODE_ENV !== 'test') {
    throw new Error('PersistenceWriter requires identity — set config.identity or check registry entry')
  }

  const stamp = {
    strategy: identity?.strategy ?? 'legacy',
    subAccountId: identity?.subAccountId ?? 'legacy',
  }

  const pendingPnlTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingPnlIntentIds = new Set<string>()

  const queue: QueuedWrite[] = []
  let flushTimer: ReturnType<typeof setInterval> | undefined
  const unsubs: (() => void)[] = []

  // Track last known status per intent for lifecycle event from_status calculation.
  const prevStatusByIntent = new Map<string, string>()
  const prevLifecycleTsByIntent = new Map<string, number>()

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
      fundingInterval:
        typeof intent.fundingInterval === 'string' ? parseInt(intent.fundingInterval, 10) : intent.fundingInterval,
      nextFundingTs: new Date(intent.nextFundingTimestamp),
      decidedAt: new Date(intent.decidedAt),
      entryAt: new Date(intent.entryAt),
      status: state.status,
      exitPolicy: intent.exitPolicy,
      subAccountId: stamp.subAccountId,
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

  async function computeAndEnqueuePnl(intentId: string, exitEvent: IntentExitedEvent): Promise<void> {
    const fillRows = await db
      .select({
        qty: fills.qty,
        price: fills.price,
        feeAmount: fills.feeAmount,
        orderKind: fills.orderKind,
      })
      .from(fills)
      .innerJoin(orders, eq(fills.orderId, orders.id))
      .where(eq(orders.intentId, intentId))

    const fundingRows = await db
      .select({ fundingAmount: fundingAttributions.fundingAmount })
      .from(fundingAttributions)
      .where(eq(fundingAttributions.intentId, intentId))

    let entryFees = 0
    let exitFees = 0
    for (const f of fillRows) {
      const fee = parseFloat(f.feeAmount)
      if (!isNaN(fee)) {
        if (f.orderKind === 'entry' || f.orderKind === 'pre_funding') entryFees += fee
        else exitFees += fee
      }
    }

    let fundingTotal = 0
    for (const f of fundingRows) {
      const amt = parseFloat(f.fundingAmount)
      if (!isNaN(amt)) fundingTotal += amt
    }

    const qty = exitEvent.qty
    const entryPx = exitEvent.avgEntryPrice
    const exitPx = exitEvent.avgExitPrice

    let grossPnl: number | null = null
    if (entryPx != null && exitPx != null && qty > 0) {
      grossPnl = exitEvent.side === 'long' ? (exitPx - entryPx) * qty : (entryPx - exitPx) * qty
    }

    const netPnl = grossPnl != null ? grossPnl - entryFees - exitFees + fundingTotal : null

    const holdDurationMs = exitEvent.entryFilledAt != null ? exitEvent.exitFilledAt - exitEvent.entryFilledAt : null

    enqueue({
      table: 'realized_pnl',
      row: {
        intentId,
        exchange: exitEvent.exchange,
        symbol: exitEvent.symbol,
        qty: String(qty),
        avgEntryPrice: entryPx != null ? String(entryPx) : null,
        avgExitPrice: exitPx != null ? String(exitPx) : null,
        grossPnl: grossPnl != null ? String(grossPnl) : null,
        entryFees: String(entryFees),
        exitFees: String(exitFees),
        fundingTotal: String(fundingTotal),
        netPnl: netPnl != null ? String(netPnl) : null,
        holdDurationMs,
        exitReason: exitEvent.exitReason,
        computedAt: new Date(),
        strategy: stamp.strategy,
        subAccountId: stamp.subAccountId,
      },
    })
  }

  function subscribeAll(): void {
    unsubs.push(
      bus.on('intent.decided', intent => {
        prevStatusByIntent.set(intent.id, 'decided')
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
        const fromStatus = prevStatusByIntent.get(state.intent.id) ?? null
        prevStatusByIntent.set(state.intent.id, state.status)

        const row: Record<string, unknown> = { id: state.intent.id, status: state.status }
        if (state.status === 'exited') row.exitAt = new Date()
        enqueue({
          table: 'trade_intents',
          row,
          onConflict: 'update',
        })

        const nowMs = Date.now()
        const prevTs = prevLifecycleTsByIntent.get(state.intent.id)
        const latencyMs = prevTs != null ? nowMs - prevTs : null
        prevLifecycleTsByIntent.set(state.intent.id, nowMs)

        let ctx: Record<string, unknown> | null = null
        if ((state.status === 'exiting' || state.status === 'exited') && state.exitReason) {
          ctx = { reason: state.exitReason }
        } else if (state.status === 'error' && state.error) {
          ctx = { code: state.error.code, message: state.error.message }
        }

        enqueue({
          table: 'intent_lifecycle_events',
          row: {
            id: randomUUID(),
            intentId: state.intent.id,
            fromStatus,
            toStatus: state.status,
            ts: new Date(),
            latencyMs,
            context: ctx,
          },
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
          kind: event.kind,
          reduceOnly: event.reduceOnly,
          qty: String(event.qty),
          filledQty: '0',
          price: event.price != null ? String(event.price) : null,
          stopPrice: event.stopPrice != null ? String(event.stopPrice) : null,
          status: 'new',
          submittedAt: new Date(),
          strategy: stamp.strategy,
          subAccountId: stamp.subAccountId,
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
        if (order.filledQty > 0) {
          row.firstFillAt = new Date(order.updatedAt)
          row.workingAt = new Date(order.submittedAt)
        }
        enqueue({ table: 'orders_status', row })
      })
    )

    // Write fill rows; requires a DB lookup to resolve the order UUID, intent_id, and kind.
    // On order-not-found: insert into fills_dead_letter and emit fill.unmatched log.
    // On success: enqueue fill row so it benefits from queue retry + WAL fallback.
    unsubs.push(
      bus.on('ws.fill', event => {
        void (async () => {
          try {
            let orderRow: { id: string; intentId: string; kind: string | null } | undefined

            // Primary lookup: by clientOrderId when non-empty
            if (event.clientOrderId) {
              const [row] = await db
                .select({ id: orders.id, intentId: orders.intentId, kind: orders.kind })
                .from(orders)
                .where(and(eq(orders.exchange, event.exchange), eq(orders.clientOrderId, event.clientOrderId)))
                .limit(1)
              orderRow = row
            }

            // Fallback: by exchangeOrderId for exchanges that omit clientOrderId
            if (!orderRow && event.exchangeOrderId) {
              const [row] = await db
                .select({ id: orders.id, intentId: orders.intentId, kind: orders.kind })
                .from(orders)
                .where(and(eq(orders.exchange, event.exchange), eq(orders.exchangeOrderId, event.exchangeOrderId)))
                .limit(1)
              orderRow = row
            }

            if (!orderRow) {
              logFillUnmatched(logger, {
                exchange: event.exchange,
                symbol: event.symbol,
                clientOrderId: event.clientOrderId,
                exchangeFillId: event.exchangeFillId,
                rawFill: event,
                reason: 'order_not_found',
              })
              try {
                await db.insert(fillsDeadLetter).values({
                  ts: new Date(),
                  exchange: event.exchange,
                  symbol: event.symbol,
                  clientOrderId: event.clientOrderId,
                  reason: 'order_not_found',
                  rawFillEvent: event as unknown as Record<string, unknown>,
                  subAccountId: identity?.subAccountId ?? null,
                })
              } catch (dlErr) {
                logger.warn({ dlErr, exchangeFillId: event.exchangeFillId }, 'persistence: dead-letter insert failed')
              }
              return
            }
            enqueue({
              table: 'fills',
              row: {
                id: randomUUID(),
                orderId: orderRow.id,
                exchange: event.exchange,
                exchangeFillId: event.exchangeFillId,
                qty: String(event.qty),
                price: String(event.price),
                feeAsset: event.feeAsset,
                feeAmount: String(event.feeAmount),
                isMaker: event.isMaker,
                ts: new Date(event.ts),
                intentId: orderRow.intentId,
                orderKind: orderRow.kind,
                strategy: stamp.strategy,
                subAccountId: stamp.subAccountId,
              },
              onConflict: 'ignore',
            })
            metrics.writesTotal.inc(1, { table: 'fills', result: 'queued' })
          } catch (err) {
            logFillUnmatched(logger, {
              exchange: event.exchange,
              symbol: event.symbol,
              clientOrderId: event.clientOrderId,
              exchangeFillId: event.exchangeFillId,
              reason: 'lookup_failed',
            })
            logger.warn({ err, exchangeFillId: event.exchangeFillId }, 'persistence: fill lookup failed')
            metrics.writesTotal.inc(1, { table: 'fills', result: 'error' })
          }
        })()
      })
    )

    unsubs.push(
      bus.on('exit.triggered', event => {
        enqueue({
          table: 'exit_triggers',
          row: {
            id: randomUUID(),
            intentId: event.intentId,
            reason: event.reason,
            triggerPrice: event.triggerPrice != null ? String(event.triggerPrice) : null,
            triggerTs: new Date(event.triggerTs),
            source: event.source,
            exitOrderClientId: event.exitOrderClientId ?? null,
            latencyMs: event.latencyMs ?? null,
            context: {
              source: event.source,
              triggerEvent: event.reason,
              ...(event.exitOrderClientId !== undefined ? { exitOrderClientId: event.exitOrderClientId } : {}),
            },
          },
        })
      })
    )

    unsubs.push(
      bus.on('intent.exited', event => {
        void (async () => {
          try {
            // Enrich the trade_intents row with final prices, reason, and timestamps.
            const intentUpdate: Record<string, unknown> = {
              id: event.intentId,
              exitReason: event.exitReason,
              exitFilledAt: new Date(event.exitFilledAt),
            }
            if (event.avgEntryPrice != null) intentUpdate.avgEntryPrice = String(event.avgEntryPrice)
            if (event.avgExitPrice != null) intentUpdate.avgExitPrice = String(event.avgExitPrice)
            if (event.entryFilledAt != null) intentUpdate.entryFilledAt = new Date(event.entryFilledAt)
            enqueue({ table: 'trade_intents', row: intentUpdate, onConflict: 'update' })

            // Query funding attributions to decide whether to defer PnL computation.
            const fundingRows = await db
              .select({ fundingAmount: fundingAttributions.fundingAmount })
              .from(fundingAttributions)
              .where(eq(fundingAttributions.intentId, event.intentId))

            // If no funding attributions yet, check whether a funding tick occurred in this window.
            // If so, defer the realized_pnl write for 30s to allow the WS event to arrive.
            if (fundingRows.length === 0 && event.entryFilledAt != null) {
              try {
                const [intentInfo] = await db
                  .select({ nextFundingTs: tradeIntents.nextFundingTs })
                  .from(tradeIntents)
                  .where(eq(tradeIntents.id, event.intentId))
                const WINDOW_TOLERANCE_MS = 60_000
                if (intentInfo?.nextFundingTs) {
                  const nextFundingMs = intentInfo.nextFundingTs.getTime()
                  const entryMs = event.entryFilledAt
                  const exitMs = event.exitFilledAt
                  if (entryMs <= nextFundingMs && nextFundingMs <= exitMs + WINDOW_TOLERANCE_MS) {
                    // Defer: a funding event likely occurred but hasn't been processed yet.
                    pendingPnlIntentIds.add(event.intentId)
                    const deferred = event
                    const timer = setTimeout(() => {
                      pendingPnlTimers.delete(deferred.intentId)
                      pendingPnlIntentIds.delete(deferred.intentId)
                      void computeAndEnqueuePnl(deferred.intentId, deferred)
                    }, 30_000)
                    pendingPnlTimers.set(event.intentId, timer)
                    return
                  }
                }
              } catch {
                // proceed with immediate write if check fails
              }
            }

            await computeAndEnqueuePnl(event.intentId, event)
          } catch (err) {
            logger.warn({ err, intentId: event.intentId }, 'persistence: intent.exited handler failed')
          }
        })()
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
            available: toFiniteStr(balance.available) ?? '0',
            locked: toFiniteStr(balance.locked) ?? '0',
            balance: toFiniteStr(balance.walletBalance),
            unrealizedPnl: toFiniteStr(balance.unrealizedPnl),
            reason: 'periodic',
            ts: new Date(balance.updatedAt),
            strategy: stamp.strategy,
            subAccountId: stamp.subAccountId,
          },
          onConflict: 'ignore',
        })
      })
    )

    unsubs.push(
      bus.on('ws.funding_fee', event => {
        void (async () => {
          const fundingTime = new Date(event.fundingTime)
          const TOLERANCE_MS = 60_000 // allow attribution for intents that exited up to 1 min after fundingTime

          let candidates: Array<{ id: string }> = []
          try {
            candidates = await db
              .select({ id: tradeIntents.id })
              .from(tradeIntents)
              .where(
                and(
                  eq(tradeIntents.exchange, event.exchange),
                  eq(tradeIntents.symbol, event.symbol),
                  eq(tradeIntents.subAccountId, stamp.subAccountId),
                  lte(tradeIntents.entryFilledAt, fundingTime),
                  or(
                    isNull(tradeIntents.exitFilledAt),
                    gte(tradeIntents.exitFilledAt, new Date(event.fundingTime - TOLERANCE_MS))
                  )
                )
              )
          } catch {
            // candidates stays empty
          }

          if (candidates.length === 0) {
            logger.warn(
              {
                event: 'funding.unattributed',
                exchange: event.exchange,
                symbol: event.symbol,
                subAccountId: stamp.subAccountId,
                fundingTime: event.fundingTime,
              },
              'funding.unattributed'
            )
            enqueue({
              table: 'funding_attributions',
              row: {
                id: randomUUID(),
                exchange: event.exchange,
                symbol: event.symbol,
                positionId: null,
                intentId: null,
                fundingTime,
                fundingRate: String(event.fundingRate),
                fundingAmount: String(event.fundingAmount),
                asset: event.asset,
                ts: new Date(),
                strategy: stamp.strategy,
                subAccountId: stamp.subAccountId,
              },
              onConflict: 'ignore',
            })
          } else {
            for (const { id: intentId } of candidates) {
              enqueue({
                table: 'funding_attributions',
                row: {
                  id: randomUUID(),
                  exchange: event.exchange,
                  symbol: event.symbol,
                  positionId: null,
                  intentId,
                  fundingTime,
                  fundingRate: String(event.fundingRate),
                  fundingAmount: String(event.fundingAmount),
                  asset: event.asset,
                  ts: new Date(),
                  strategy: stamp.strategy,
                  subAccountId: stamp.subAccountId,
                },
                onConflict: 'ignore',
              })
            }
          }

          // If any deferred PnL writes were waiting for this intent's funding event, trigger them now
          for (const intentId of [...pendingPnlIntentIds]) {
            if (candidates.some(c => c.id === intentId)) {
              const timer = pendingPnlTimers.get(intentId)
              if (timer !== undefined) clearTimeout(timer)
              pendingPnlTimers.delete(intentId)
              pendingPnlIntentIds.delete(intentId)
              // We need the exit event data — fetch from DB then recompute
              // Use a minimal stand-in: computeAndEnqueuePnl with just intentId
              // (the function reads fills/funding from DB anyway)
              void (async () => {
                try {
                  const [row] = await db
                    .select({
                      exitReason: tradeIntents.exitReason,
                      avgEntryPrice: tradeIntents.avgEntryPrice,
                      avgExitPrice: tradeIntents.avgExitPrice,
                      exitFilledAt: tradeIntents.exitFilledAt,
                      entryFilledAt: tradeIntents.entryFilledAt,
                      side: tradeIntents.side,
                      amountUsd: tradeIntents.amountUsd,
                    })
                    .from(tradeIntents)
                    .where(eq(tradeIntents.id, intentId))
                  if (!row?.exitFilledAt) return
                  // Rebuild a minimal IntentExitedEvent shape for computeAndEnqueuePnl
                  // We only need it for metadata — fills/funding are re-queried inside
                  const rebuiltEvent: IntentExitedEvent = {
                    intentId,
                    exchange: event.exchange,
                    symbol: event.symbol,
                    side: row.side,
                    qty: 0, // not needed — fills are re-queried
                    exitReason: row.exitReason ?? 'unknown',
                    decidedAt: 0,
                    exitFilledAt: row.exitFilledAt.getTime(),
                    ...(row.avgEntryPrice ? { avgEntryPrice: parseFloat(row.avgEntryPrice) } : {}),
                    ...(row.avgExitPrice ? { avgExitPrice: parseFloat(row.avgExitPrice) } : {}),
                    ...(row.entryFilledAt ? { entryFilledAt: row.entryFilledAt.getTime() } : {}),
                  }
                  await computeAndEnqueuePnl(intentId, rebuiltEvent)
                } catch {
                  // ignore
                }
              })()
            }
          }
        })()
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
            subAccountId: identity?.subAccountId ?? null,
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
            subAccountId: identity?.subAccountId ?? null,
          },
          onConflict: 'ignore',
        })
      })
    )

    unsubs.push(
      bus.on('intent.funding_gate_opened', event => {
        enqueue({ table: 'trade_intents', row: { id: event.intentId, fundingGateOpen: true }, onConflict: 'update' })
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
          wal.append({
            table: write.table,
            row: write.row,
            ...(write.onConflict !== undefined ? { onConflict: write.onConflict } : {}),
          })
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
          logWalDiscarded(logger, {
            table: entry.table,
            pgErrorCode: code,
            pgErrorText: (err as Error).message || String(err),
          })
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
      for (const timer of pendingPnlTimers.values()) clearTimeout(timer)
      pendingPnlTimers.clear()
      pendingPnlIntentIds.clear()
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
        kind: params.kind,
        reduceOnly: params.reduceOnly,
        qty: String(params.qty),
        filledQty: '0',
        price: params.price != null ? String(params.price) : null,
        stopPrice: params.stopPrice != null ? String(params.stopPrice) : null,
        intendedPrice: params.intendedPrice != null ? String(params.intendedPrice) : null,
        status: 'new',
        submittedAt: new Date(),
        strategy: stamp.strategy,
        subAccountId: stamp.subAccountId,
      }
      try {
        await db.insert(orders).values(row).onConflictDoNothing()
        metrics.writesTotal.inc(1, { table: 'orders', result: 'sync_success' })
      } catch (err) {
        logger.warn(
          { err, clientOrderId: params.clientOrderId },
          'persistence: sync order write failed, buffering to WAL'
        )
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
        await db
          .insert(tradeIntents)
          .values(row as typeof tradeIntents.$inferInsert)
          .onConflictDoNothing()
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
