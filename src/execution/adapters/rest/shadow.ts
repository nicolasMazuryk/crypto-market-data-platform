import type { Logger } from 'pino'

import type { Clock, EventBus } from '../../core/types.js'
import type { Exchange } from '../../types/exchange.js'
import type { RestMetrics } from '../../observability/metrics.js'
import type {
  ExchangeRestAdapter,
  OrderRequest,
  OrderAck,
  Order,
  Position,
  Balance,
  OrderRef,
  OrderAmendPatch,
} from './types.js'

export interface ShadowRestAdapterOptions {
  exchange: Exchange
  clock: Clock
  logger: Logger
  metrics: RestMetrics
  bus?: EventBus
  /** Delay in ms before a created order transitions to filled. Default: 150ms */
  fillDelayMs?: number
  /** Synthetic USDT balance for preflight balance check. Default: 100_000 */
  syntheticBalanceUsdt?: number
}

export function createShadowRestAdapter(opts: ShadowRestAdapterOptions): ExchangeRestAdapter {
  const { exchange, clock, logger, metrics } = opts
  const fillDelayMs = opts.fillDelayMs ?? 150
  let seq = 0

  // In-memory order state for dry-run fill simulation
  const orderStore = new Map<string, Order>()

  function shadowAck(clientOrderId: string, req: OrderRequest): OrderAck {
    const now = clock.now()
    const exchangeOrderId = `shadow-${clientOrderId}`

    const order: Order = {
      exchange,
      symbol: req.symbol,
      clientOrderId,
      exchangeOrderId,
      side: req.side,
      type: req.type,
      qty: req.qty,
      filledQty: 0,
      ...(req.price !== undefined ? { price: req.price } : {}),
      ...(req.stopPrice !== undefined ? { stopPrice: req.stopPrice } : {}),
      reduceOnly: req.reduceOnly ?? false,
      status: 'new',
      submittedAt: now,
      updatedAt: now,
    }
    orderStore.set(clientOrderId, order)

    setTimeout(() => {
      const stored = orderStore.get(clientOrderId)
      if (stored && stored.status !== 'cancelled') {
        stored.filledQty = req.qty
        stored.status = 'filled'
        stored.updatedAt = clock.now()
        if (opts.bus) {
          opts.bus.emit('ws.order', { exchange, order: { ...stored }, seq: ++seq, receivedAt: clock.now() })
        }
      }
    }, fillDelayMs)

    return {
      clientOrderId,
      exchangeOrderId,
      status: 'accepted',
      submittedAt: now,
      ackedAt: now,
    }
  }

  return {
    exchange,

    setLeverage(symbol: string, leverage: number): Promise<void> {
      logger.info({ exchange, symbol, leverage, shadow: true }, 'shadow.setLeverage')
      return Promise.resolve()
    },

    createOrder(req: OrderRequest): Promise<OrderAck> {
      const ack = shadowAck(req.clientOrderId, req)
      logger.info({ exchange, req, ack, shadow: true }, 'shadow.createOrder')
      metrics.ordersTotal.inc(1, { exchange, side: req.side, type: req.type, status: 'shadow' })
      return Promise.resolve(ack)
    },

    cancelOrder(ref: OrderRef): Promise<void> {
      logger.info({ exchange, ref, shadow: true }, 'shadow.cancelOrder')
      const order = orderStore.get(ref.clientOrderId ?? '')
      if (order && order.status !== 'filled') {
        order.status = 'cancelled'
        order.updatedAt = clock.now()
      }
      return Promise.resolve()
    },

    amendOrder(ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>, patch: OrderAmendPatch): Promise<OrderAck> {
      const order = orderStore.get(ref.clientOrderId)
      const now = clock.now()
      if (order) {
        if (patch.price !== undefined) order.price = patch.price
        if (patch.qty !== undefined) order.qty = patch.qty
        order.updatedAt = now
      }
      const ack: OrderAck = {
        clientOrderId: ref.clientOrderId,
        exchangeOrderId: order?.exchangeOrderId ?? `shadow-${ref.clientOrderId}`,
        status: 'accepted',
        submittedAt: now,
        ackedAt: now,
      }
      logger.info({ exchange, ref, patch, ack, shadow: true }, 'shadow.amendOrder')
      return Promise.resolve(ack)
    },

    getOpenOrders(_symbol?: string): Promise<Order[]> {
      const open = Array.from(orderStore.values()).filter(
        o => o.status === 'new' || o.status === 'partially_filled'
      )
      return Promise.resolve(open)
    },

    getOrder(ref: OrderRef): Promise<Order | undefined> {
      const key = ref.clientOrderId ?? ''
      return Promise.resolve(orderStore.get(key))
    },

    getPositions(_symbol?: string): Promise<Position[]> {
      return Promise.resolve([])
    },

    getBalance(_asset?: string): Promise<Balance[]> {
      const usdt = opts.syntheticBalanceUsdt ?? 100_000
      return Promise.resolve([{ exchange, asset: 'USDT', available: usdt, locked: 0, updatedAt: clock.now() }])
    },

    getServerTime(): Promise<number> {
      return Promise.resolve(clock.now())
    },
  }
}
