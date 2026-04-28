import type { Exchange, Unsubscribe } from '../types/exchange.js'
import type { Balance, Order, Position } from '../adapters/rest/types.js'

export type DesyncKind =
  | 'unknown_order'
  | 'missing_order'
  | 'order_status_mismatch'
  | 'position_qty_mismatch'
  | 'balance_mismatch'
  | 'sequence_gap'
  | 'orphan_reduce_only_order'

export interface DesyncEvent {
  exchange: Exchange
  kind: DesyncKind
  details: unknown
  detectedAt: number
}

export interface StateStore {
  orders(exchange: Exchange, symbol?: string): Order[]
  positions(exchange: Exchange, symbol?: string): Position[]
  balances(exchange: Exchange, asset?: string): Balance[]
  reconcile(exchange: Exchange): Promise<void>
  onDesync(listener: (desync: DesyncEvent) => void): Unsubscribe
}
