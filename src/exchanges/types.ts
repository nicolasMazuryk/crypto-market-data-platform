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

export interface CcxtExchange {
  loadMarkets(): Promise<Record<string, CcxtMarket>>
  market(symbol: string): CcxtMarket
  markets: Record<string, CcxtMarket>
  markets_by_id?: Record<string, CcxtMarket | CcxtMarket[]>
  has?: Record<string, boolean>
  rateLimit?: number
  fetchFundingRateHistory?(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>[]>
  close?(): Promise<void>
}
