import type { Exchange } from '../../types/exchange.js'

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop_market'
export type TimeInForce = 'GTC' | 'IOC' | 'FOK'
export type MarginMode = 'cross' | 'isolated'
export type PositionMode = 'one_way' | 'hedge'

export type OrderStatus = 'new' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired'

export interface OrderRequest {
  intentId: string
  clientOrderId: string
  exchange: Exchange
  symbol: string
  side: OrderSide
  type: OrderType
  qty: number
  price?: number
  stopPrice?: number
  reduceOnly?: boolean
  timeInForce?: TimeInForce
  leverage?: number
}

export interface OrderAck {
  clientOrderId: string
  exchangeOrderId: string
  status: 'accepted' | 'rejected'
  rejectReason?: string
  submittedAt: number
  ackedAt: number
}

export interface Order {
  exchange: Exchange
  symbol: string
  clientOrderId: string
  exchangeOrderId: string
  side: OrderSide
  type: OrderType
  qty: number
  filledQty: number
  price?: number
  avgFillPrice?: number
  stopPrice?: number
  reduceOnly: boolean
  status: OrderStatus
  submittedAt: number
  updatedAt: number
}

export interface Position {
  exchange: Exchange
  symbol: string
  qty: number
  side: 'long' | 'short' | 'flat'
  entryPrice?: number
  markPrice?: number
  leverage: number
  unrealizedPnl?: number
  liquidationPrice?: number
  updatedAt: number
}

export interface Balance {
  exchange: Exchange
  asset: string
  available: number
  locked: number
  /** Total wallet equity (e.g. Binance walletBalance, Gate total, OKX cashBal). */
  walletBalance?: number
  unrealizedPnl?: number
  updatedAt: number
}

export interface OrderRef {
  symbol: string
  clientOrderId?: string
  exchangeOrderId?: string
}

export interface OrderAmendPatch {
  price?: number
  qty?: number
}

export interface FundingIncomeRecord {
  symbol: string
  fundingTime: number
  fundingAmount: number
  asset: string
}

export interface ExchangeRestAdapter {
  readonly exchange: Exchange
  canonicalizeClientOrderId?(id: string): string
  warm?(): Promise<void>
  setLeverage(symbol: string, leverage: number): Promise<void>
  setMarginMode(symbol: string, mode: MarginMode): Promise<void>
  setPositionMode(hedged: boolean, symbol?: string): Promise<void>
  createOrder(req: OrderRequest): Promise<OrderAck>
  cancelOrder(ref: OrderRef): Promise<void>
  amendOrder(ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>, patch: OrderAmendPatch): Promise<OrderAck>
  getOpenOrders(symbol?: string): Promise<Order[]>
  getOrder(ref: OrderRef): Promise<Order | undefined>
  getPositions(symbol?: string): Promise<Position[]>
  getBalance(asset?: string): Promise<Balance[]>
  getServerTime(): Promise<number>
  fetchFundingFeeIncome?(symbol: string, fundingTs: number): Promise<FundingIncomeRecord | null>
}
