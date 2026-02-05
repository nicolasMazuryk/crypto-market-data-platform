export type ClickHouseDateTime = string

export interface MarketRow {
  exchange: string
  symbol: string
  exchange_symbol: string
  type: string
  listing_date: ClickHouseDateTime | null
  delisting_date: ClickHouseDateTime | null
  is_active: boolean
  created_at?: ClickHouseDateTime
  updated_at?: ClickHouseDateTime
}

export interface FundingRateRow {
  exchange: string
  symbol: string
  exchange_symbol: string
  funding_time: ClickHouseDateTime
  funding_rate: string
  mark_price?: string | null
  created_at?: ClickHouseDateTime
}

export function toClickHouseDateTime(value: Date): ClickHouseDateTime {
  return value.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
}
