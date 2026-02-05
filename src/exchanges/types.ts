export type ExchangeName =
  | 'binance'
  | 'bybit'
  | 'okx'
  | 'mexc'
  | 'bitget'
  | 'gateio'
  | 'kucoin'

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
  active?: boolean
  swap?: boolean
  linear?: boolean
  settle?: string
  info?: Record<string, unknown>
  [key: string]: unknown
}

export interface CcxtExchange {
  loadMarkets(): Promise<Record<string, CcxtMarket>>
  markets: Record<string, CcxtMarket>
}
