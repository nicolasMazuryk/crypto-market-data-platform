import type { Exchange, FundingInterval, Unsubscribe } from '../types/exchange.js'

export interface ExchangeFundingPuller {
  exchange: Exchange
  pull(): Promise<FundingSnapshot[]>
}

export interface FundingSnapshot {
  exchange: Exchange
  symbol: string
  exchangeSymbol: string
  fundingRate: number
  fundingRatePercent: number
  fundingInterval: FundingInterval
  nextFundingTimestamp: number
  nextFundingDatetime: string
  timestamp: number
  markPrice?: number
}

export interface FundingRateSource {
  latest(exchange: Exchange): Map<string, FundingSnapshot>
  onSnapshot(listener: (snapshot: FundingSnapshot) => void): Unsubscribe
  start(): Promise<void>
  stop(): Promise<void>
}
