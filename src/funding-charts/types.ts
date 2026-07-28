/**
 * Realized trade for one funding event, sourced from a backtest report's `trade_log`.
 * Present only on report-driven runs; threshold-driven runs leave `FundingEvent.trade` undefined
 * and render exactly as before.
 */
export interface TradeOverlay {
  entry_ts: Date
  exit_ts: Date
  entry_price: number
  exit_price: number
  sl_price: number | null
  tp_price: number | null
  exit_reason: string
  /** Net P&L in percent, as stored in the report trade log. */
  net_pnl: number
}

export interface FundingEvent {
  exchange: string
  symbol: string
  funding_time: Date
  funding_rate: number
  trade?: TradeOverlay
}

export interface OrderbookRow {
  ts: Date
  bid_open: number | null
  bid_high: number | null
  bid_low: number | null
  bid_close: number | null
  ask_open: number | null
  ask_high: number | null
  ask_low: number | null
  ask_close: number | null
}

export interface ChartConfig {
  funding_rate_threshold: number
  threshold_mode: 'lte' | 'gte' | 'abs_gte'
  exchanges: string[]
  symbols: string[]
  date_range: { from: string | null; to: string | null }
  pre_seconds: number
  post_seconds: number
  output_dir: string
  image_width: number
  image_height: number
  overwrite: boolean
  worker_count: number
  db_concurrency_per_worker: number
  show_fib_ladder: boolean
  show_spread_shade: boolean
}

export type WorkerMessage =
  | { type: 'progress'; done: number; skipped: number; errors: number }
  | { type: 'done'; done: number; skipped: number; errors: number }

export interface ClickHouseConnectionConfig {
  host: string
  httpPort: string
  database: string
  user: string
  password: string
}

export interface WorkerInput {
  events: FundingEvent[]
  config: ChartConfig
  workerId: number
  clickhouse: ClickHouseConnectionConfig
}
