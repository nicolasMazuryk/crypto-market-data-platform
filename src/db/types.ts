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

export interface DownloadTaskRow {
  exchange: string
  symbol: string
  date: string
  status: 'pending' | 'downloading' | 'processing' | 'completed' | 'failed'
  error_message: string | null
  file_size_bytes: number | null
  rows_written: number | null
  quality_score: number | null
  created_at?: ClickHouseDateTime
  updated_at?: ClickHouseDateTime
}

export interface OrderbookRow {
  exchange: string
  symbol: string
  ts: ClickHouseDateTime
  bid_open: number | null
  bid_high: number | null
  bid_low: number | null
  bid_close: number | null
  ask_open: number | null
  ask_high: number | null
  ask_low: number | null
  ask_close: number | null
  source_type: string
  is_interpolated: boolean
  confidence_score: string
  missing_reason: string | null
}

export function toClickHouseDateTime(value: Date): ClickHouseDateTime {
  return value.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
}
