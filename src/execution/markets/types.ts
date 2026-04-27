import type { Exchange, Unsubscribe } from '../types/exchange.js'

export type MarketStatus = 'trading' | 'halted' | 'delisted'

export interface MarketMetadata {
  exchange: Exchange
  symbol: string
  exchangeSymbol: string
  contractSize: number
  pricePrecision: number
  amountPrecision: number
  minPrice?: number
  maxPrice?: number
  minAmount?: number
  maxAmount?: number
  minCost?: number
  maxLeverage?: number
  makerFee: number
  takerFee: number
  status: MarketStatus
}

export interface MarketMetadataDelta {
  added: MarketMetadata[]
  removed: MarketMetadata[]
  changed: MarketMetadata[]
}

export interface MarketMetadataProvider {
  list(exchange: Exchange): MarketMetadata[]
  get(exchange: Exchange, symbol: string): MarketMetadata | undefined
  resolve(exchange: Exchange, normalizedSymbol: string): string | undefined
  refresh(exchange?: Exchange): Promise<void>
  onUpdate(listener: (delta: MarketMetadataDelta) => void): Unsubscribe
}
