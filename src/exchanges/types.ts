export type ExchangeName = 'binance' | 'bybit' | 'okx' | 'mexc' | 'bitget' | 'gateio' | 'kucoin'

export interface Market {
  exchange: ExchangeName
  symbol: string
  exchange_symbol: string
  type: 'perpetual'
  listing_date: Date | null
  delisting_date: Date | null
  is_active: boolean
}

export interface ExchangeConfig {
  name: ExchangeName
  ccxtId: string
  options?: Record<string, unknown>
}

export interface CcxtMarket {
  id: string
  symbol: string
  info?: Record<string, unknown>
  active?: boolean
  contract?: boolean
  future?: boolean
  inverse?: boolean
  swap?: boolean
  linear?: boolean
  settle?: string
  [key: string]: unknown
}

export interface CcxtFundingRate {
  symbol: string
  fundingRate: number | undefined
  fundingTimestamp: number | undefined
  fundingDatetime: string | undefined
  interval: string | undefined
  info: Record<string, unknown>
  [key: string]: unknown
}

export interface CcxtOrder {
  id: string
  clientOrderId?: string
  symbol: string
  side?: string
  type?: string
  price?: number
  amount?: number
  filled?: number
  status?: string
  average?: number
  stopPrice?: number
  reduceOnly?: boolean
  timeInForce?: string
  timestamp?: number
  lastUpdateTimestamp?: number
  info: Record<string, unknown>
  [key: string]: unknown
}

export interface CcxtPosition {
  symbol: string
  side?: string
  contracts?: number
  contractSize?: number
  entryPrice?: number
  markPrice?: number
  leverage?: number
  unrealizedPnl?: number
  liquidationPrice?: number
  timestamp?: number
  info: Record<string, unknown>
  [key: string]: unknown
}

export interface CcxtBalanceResponse {
  free?: Record<string, number | undefined>
  used?: Record<string, number | undefined>
  total?: Record<string, number | undefined>
  info?: unknown
  [key: string]: unknown
}

export interface CcxtExchange {
  loadMarkets(): Promise<Record<string, CcxtMarket>>
  market(symbol: string): CcxtMarket
  markets: Record<string, CcxtMarket>
  markets_by_id?: Record<string, CcxtMarket | CcxtMarket[]>
  has?: Record<string, boolean>
  rateLimit?: number
  fetchFundingRates?(symbols?: string[], params?: Record<string, unknown>): Promise<Record<string, CcxtFundingRate>>
  fetchFundingRateHistory?(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>[]>
  createOrder?(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>
  ): Promise<CcxtOrder>
  cancelOrder?(id: string, symbol?: string, params?: Record<string, unknown>): Promise<unknown>
  editOrder?(
    id: string,
    symbol: string,
    type: string,
    side: string,
    amount?: number,
    price?: number,
    params?: Record<string, unknown>
  ): Promise<CcxtOrder>
  fetchOrder?(id: string, symbol?: string, params?: Record<string, unknown>): Promise<CcxtOrder>
  fetchOpenOrders?(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<CcxtOrder[]>
  fetchClosedOrders?(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<CcxtOrder[]>
  fetchPositions?(symbols?: string[], params?: Record<string, unknown>): Promise<CcxtPosition[]>
  fetchBalance?(params?: Record<string, unknown>): Promise<CcxtBalanceResponse>
  setLeverage?(leverage: number, symbol?: string, params?: Record<string, unknown>): Promise<unknown>
  fetchTime?(): Promise<number>
  close?(): Promise<void>
}
