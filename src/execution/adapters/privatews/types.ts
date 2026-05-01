import type { Exchange, TypedEventEmitter } from '../../types/exchange.js'
import type { Order, Position, Balance } from '../rest/types.js'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'fatal'

export interface OrderEvent {
  exchange: Exchange
  order: Order
  seq: number
  receivedAt: number
}

export interface PositionEvent {
  exchange: Exchange
  position: Position
  seq: number
  receivedAt: number
}

export interface BalanceEvent {
  exchange: Exchange
  balance: Balance
  seq: number
  receivedAt: number
}

export interface FundingFeeEvent {
  exchange: Exchange
  symbol: string
  fundingTime: number
  fundingRate: number
  fundingAmount: number
  asset: string
  positionQty: number
  receivedAt: number
}

export interface FillEvent {
  exchange: Exchange
  symbol: string
  clientOrderId: string
  exchangeFillId: string
  qty: number
  price: number
  feeAsset: string
  feeAmount: number
  isMaker: boolean
  ts: number
  receivedAt: number
}

export interface ConnectionStateEvent {
  exchange: Exchange
  state: ConnectionState
  at: number
  reason?: string
}

export interface PrivateWsEvents {
  order: (e: OrderEvent) => void
  position: (e: PositionEvent) => void
  balance: (e: BalanceEvent) => void
  fill: (e: FillEvent) => void
  fundingFee: (e: FundingFeeEvent) => void
  connectionState: (e: ConnectionStateEvent) => void
}

export interface ExchangePrivateWsAdapter {
  readonly exchange: Exchange
  connect(): Promise<void>
  disconnect(): Promise<void>
  readonly events: TypedEventEmitter<PrivateWsEvents>
}
