import type { Exchange } from '../../types/exchange.js'
import type { OrderAck, OrderAmendPatch, OrderRef, OrderRequest } from '../rest/types.js'

export interface ExchangeOrderWsAdapter {
  readonly exchange: Exchange
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** Resolves on WS ack — faster than a REST round-trip. */
  createOrder(req: OrderRequest): Promise<OrderAck>
  cancelOrder(ref: OrderRef): Promise<void>
  amendOrder(ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>, patch: OrderAmendPatch): Promise<OrderAck>
}
