import type { Logger } from 'pino'

import type { Clock } from '../core/types.js'
import type { StateMetrics } from '../observability/metrics.js'
import type { Exchange } from '../types/exchange.js'
import type { ExchangeRestAdapter, Order, Position, Balance } from '../adapters/rest/types.js'
import type { BalanceEvent, OrderEvent, PositionEvent } from '../adapters/privatews/types.js'
import type { DesyncEvent } from './types.js'

const EPSILON = 1e-9

export interface ReconcileContext {
  exchange: Exchange
  rest: ExchangeRestAdapter
  clock: Clock
  logger: Logger
  metrics: StateMetrics
  getOpenOrderCids(): Set<string>
  getOrder(cid: string): Order | undefined
  getPositions(): Map<string, Position>
  getBalances(): Map<string, Balance>
  applyOrder(order: Order): void
  applyPosition(position: Position): void
  applyBalance(balance: Balance): void
  emitDesync(e: DesyncEvent): void
  emitSyntheticOrder(e: OrderEvent): void
  emitSyntheticPosition(e: PositionEvent): void
  emitSyntheticBalance(e: BalanceEvent): void
  nextSeq(): number
}

export async function runReconcile(ctx: ReconcileContext): Promise<void> {
  const { exchange, rest, clock, logger, metrics } = ctx
  const start = clock.monotonic()

  let restOrders: Order[]
  let restPositions: Position[]
  let restBalances: Balance[]

  try {
    ;[restOrders, restPositions, restBalances] = await Promise.all([
      rest.getOpenOrders(),
      rest.getPositions(),
      rest.getBalance(),
    ])
  } catch (err) {
    logger.warn({ err, exchange }, 'reconcile: REST fetch failed, local state unchanged')
    metrics.reconcileTotal.inc(1, { exchange, status: 'error' })
    return
  }

  const now = clock.now()
  const receivedAt = now

  // --- Orders ---
  const restOrdersByCid = new Map<string, Order>(restOrders.map(o => [o.clientOrderId, o]))
  const localOpenCids = ctx.getOpenOrderCids()

  for (const restOrder of restOrders) {
    const localOrder = ctx.getOrder(restOrder.clientOrderId)
    if (!localOrder) {
      ctx.emitDesync({
        exchange,
        kind: 'unknown_order',
        details: { clientOrderId: restOrder.clientOrderId },
        detectedAt: now,
      })
      ctx.applyOrder(restOrder)
      ctx.emitSyntheticOrder({ exchange, order: restOrder, seq: ctx.nextSeq(), receivedAt })
    } else if (
      localOrder.status !== restOrder.status ||
      Math.abs(localOrder.filledQty - restOrder.filledQty) > EPSILON
    ) {
      ctx.emitDesync({
        exchange,
        kind: 'order_status_mismatch',
        details: {
          clientOrderId: restOrder.clientOrderId,
          localStatus: localOrder.status,
          restStatus: restOrder.status,
        },
        detectedAt: now,
      })
      ctx.applyOrder(restOrder)
      ctx.emitSyntheticOrder({ exchange, order: restOrder, seq: ctx.nextSeq(), receivedAt })
    }
  }

  for (const cid of localOpenCids) {
    if (!restOrdersByCid.has(cid)) {
      let terminalOrder: Order | undefined
      try {
        terminalOrder = await rest.getOrder({ symbol: '', clientOrderId: cid })
      } catch {
        // best-effort
      }
      const resolved: Order =
        terminalOrder ??
        ({
          ...(ctx.getOrder(cid) ?? {
            exchange,
            symbol: '',
            clientOrderId: cid,
            exchangeOrderId: '',
            side: 'buy',
            type: 'market',
            qty: 0,
            filledQty: 0,
            reduceOnly: false,
            submittedAt: now,
          }),
          status: 'cancelled',
          updatedAt: now,
        } as Order)
      ctx.emitDesync({
        exchange,
        kind: 'missing_order',
        details: { clientOrderId: cid, resolvedStatus: resolved.status },
        detectedAt: now,
      })
      ctx.applyOrder(resolved)
      ctx.emitSyntheticOrder({ exchange, order: resolved, seq: ctx.nextSeq(), receivedAt })
    }
  }

  // --- Positions ---
  const localPositions = ctx.getPositions()
  const restPositionsBySymbol = new Map<string, Position>(restPositions.map(p => [p.symbol, p]))

  for (const restPos of restPositions) {
    const localPos = localPositions.get(restPos.symbol)
    const localQty = localPos?.qty ?? 0
    if (Math.abs(localQty - restPos.qty) > EPSILON || localPos?.side !== restPos.side) {
      ctx.emitDesync({
        exchange,
        kind: 'position_qty_mismatch',
        details: { symbol: restPos.symbol, localQty, restQty: restPos.qty, restSide: restPos.side },
        detectedAt: now,
      })
      ctx.applyPosition(restPos)
      ctx.emitSyntheticPosition({ exchange, position: restPos, seq: ctx.nextSeq(), receivedAt })
    }
  }

  for (const [symbol, localPos] of localPositions) {
    if (!restPositionsBySymbol.has(symbol) && localPos.qty > 0) {
      const flat: Position = { ...localPos, qty: 0, side: 'flat', updatedAt: now }
      ctx.emitDesync({
        exchange,
        kind: 'position_qty_mismatch',
        details: { symbol, localQty: localPos.qty, restQty: 0, restSide: 'flat' },
        detectedAt: now,
      })
      ctx.applyPosition(flat)
      ctx.emitSyntheticPosition({ exchange, position: flat, seq: ctx.nextSeq(), receivedAt })
    }
  }

  // --- Orphan reduce-only orders ---
  // Reduce-only orders left on the exchange after the position they were guarding has
  // closed are stale: when SL fills, TP must be cancelled (and vice versa). The targeted
  // cancellation in the manager can fail silently; this is the catch-all.
  const restPositionSymbols = new Set(restPositions.filter(p => p.qty > EPSILON).map(p => p.symbol))
  for (const restOrder of restOrders) {
    if (!restOrder.reduceOnly) continue
    if (restPositionSymbols.has(restOrder.symbol)) continue
    ctx.emitDesync({
      exchange,
      kind: 'orphan_reduce_only_order',
      details: {
        symbol: restOrder.symbol,
        clientOrderId: restOrder.clientOrderId,
        exchangeOrderId: restOrder.exchangeOrderId,
        type: restOrder.type,
      },
      detectedAt: now,
    })
  }

  // --- Balances ---
  const localBalances = ctx.getBalances()

  for (const restBal of restBalances) {
    const localBal = localBalances.get(restBal.asset)
    if (
      !localBal ||
      Math.abs(localBal.available - restBal.available) > EPSILON ||
      Math.abs(localBal.locked - restBal.locked) > EPSILON
    ) {
      ctx.emitDesync({
        exchange,
        kind: 'balance_mismatch',
        details: {
          asset: restBal.asset,
          localAvailable: localBal?.available,
          restAvailable: restBal.available,
        },
        detectedAt: now,
      })
      ctx.applyBalance(restBal)
      ctx.emitSyntheticBalance({ exchange, balance: restBal, seq: ctx.nextSeq(), receivedAt })
    }
  }

  const durationMs = clock.monotonic() - start
  metrics.reconcileTotal.inc(1, { exchange, status: 'ok' })
  metrics.reconcileDurationMs.observe(durationMs, { exchange })
  logger.debug({ exchange, durationMs }, 'reconcile.complete')
}
