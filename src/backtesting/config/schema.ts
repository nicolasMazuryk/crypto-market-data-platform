/** Strategy direction */
export type StrategyDirection = 'long' | 'short'

/** Take-profit mode for Strategy 3 */
export type TpMode = 'A' | 'B'

/** Exit reason for a trade */
export type ExitReason =
  | 'TP_HIT'
  | 'SL_HIT'
  | 'DEADLINE'
  | 'MARKET_EXIT'
  | 'UNFILLED'
  | 'FUNDING_FLOOR'
  | 'SPREAD_TP'
  | 'SPREAD_SL'

/** Exchange fee schedule */
export interface FeeSchedule {
  taker_fee: number
  maker_fee: number
}

/** Data validation thresholds */
export interface ValidationConfig {
  /** Required seconds around T_funding: [T - required_seconds_before, T + required_seconds_after] */
  required_seconds_before: number
  required_seconds_after: number
  /** Max consecutive missing seconds before flagging staleness */
  max_gap_seconds: number
  /** Max price change % within window (e.g., 0.20 for 20%) */
  max_price_change_pct: number
}

/** Orderbook data window around each funding event */
export interface WindowConfig {
  /** Seconds before T_funding to start fetching data */
  pre_funding_seconds: number
  /** Seconds after T_funding to stop fetching data */
  post_funding_seconds: number
}

/** Slippage configuration for stop orders */
export interface SlippageConfig {
  /** Slippage as a fraction (e.g., 0.0001 for 0.01%) */
  stop_order_slippage: number
}

/** Reporting configuration */
export interface ReportingConfig {
  /** Whether to include per-trade log in the report */
  include_trade_log: boolean
  /** Output directory for reports */
  output_dir: string
}

/** Funding settlement detection config */
export interface FundingSettlementConfig {
  /** Lookahead window after T_funding to search for the price-drop candle (1..60) */
  detection_window_seconds: number
  /** TP cannot become valid until real_settlement_ts + buffer (strategy_2 only; >= 0) */
  tp_post_settlement_buffer_seconds: number
}

/** Base config shared by all strategies */
export interface BaseConfig {
  /** Exchange to backtest (e.g., "binanceusdm") */
  exchange: string
  /** Symbol to backtest (e.g., "BTCUSDT"). Omit to run for all symbols on the exchange. */
  symbol?: string
  /** Start date for backtest (ISO 8601) */
  start_date: string
  /** End date for backtest (ISO 8601) */
  end_date: string
  /** Fee schedules per exchange */
  fees: Record<string, FeeSchedule>
  /** Data validation config */
  validation: ValidationConfig
  /** Data window config */
  window: WindowConfig
  /** Slippage config */
  slippage: SlippageConfig
  /** Reporting config */
  reporting: ReportingConfig
  /** Funding settlement detection config */
  funding_settlement: FundingSettlementConfig
}

/** Strategy 1: Negative Funding LONG - Instant Exit */
export interface Strategy1Config {
  strategy_id: 'strategy_1'
  direction: 'long'
  /** Minimum absolute funding rate to trigger (e.g., 0.004 for 0.4%) */
  funding_threshold: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Seconds after T_funding to exit (>= 2, market-order latency) */
  exit_offset_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
}

/** Strategy 2: Negative Funding LONG - Retracement Exit */
export interface Strategy2Config {
  strategy_id: 'strategy_2'
  direction: 'long'
  funding_threshold: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Retracement level (0-1, e.g., 0.50 for 50%) */
  retracement_pct: number
  /** Max seconds after T_funding before forced exit (2..180) */
  deadline_seconds: number
  /** Stop-loss multiplier: SL at entry_price × (1 − |F| × sl_mult) */
  sl_mult: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
}

/** Strategy 3: Negative Funding SHORT - Ride the Drop */
export interface Strategy3Config {
  strategy_id: 'strategy_3a'
  direction: 'short'
  funding_threshold: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Stop-loss distance as fraction (e.g., 0.01 for 1%) */
  stop_loss: number
  /** Take-profit mode: A = F*1.5, B = F+0.004 */
  tp_mode: TpMode
  /** TP multiplier for mode A (e.g., 1.5) */
  tp_multiplier: number
  /** TP addend in PERCENT for variant B (e.g., 0.4 for 0.4%) */
  tp_addend_pct: number
  /** Max seconds after T_funding before forced exit (>= 2) */
  deadline_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
}

/** Strategy 4.1: Negative Funding Ladder LONG - Post-Funding Entry */
export interface Strategy41Config {
  strategy_id: 'strategy_4_1a'
  direction: 'long'
  funding_threshold: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Number of limit orders in the ladder (>= 2) */
  ladder_count: number
  /** Multiplier for top of ladder range */
  ladder_top_mult: number
  /** Multiplier for bottom of ladder range */
  ladder_bottom_mult: number
  /** Take-profit above average entry (e.g., 0.002 for 0.2%) */
  take_profit: number
  /** Max seconds after T_funding before forced exit (2..180) */
  deadline_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
  /** Stop-loss multiplier: SL at P_avg × (1 − |F| × sl_mult) */
  sl_mult: number
}

/** Strategy 4.2: Negative Funding Single LONG - Post-Funding Entry */
export interface Strategy42Config {
  strategy_id: 'strategy_4_2a'
  direction: 'long'
  funding_threshold: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Multiplier for limit price offset */
  limit_offset_mult: number
  take_profit: number
  /** Max seconds after T_funding before forced exit (2..180) */
  deadline_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
  /** Stop-loss multiplier: SL at entry_price × (1 − |F| × sl_mult); must be > limit_offset_mult */
  sl_mult: number
}

/** Union of all strategy configs */
export type StrategyConfig = Strategy1Config | Strategy2Config | Strategy3Config | Strategy41Config | Strategy42Config

/** Fully resolved config: base merged with strategy */
export interface ResolvedConfig {
  base: BaseConfig
  strategy: StrategyConfig
}

/** All valid strategy IDs */
export const VALID_STRATEGY_IDS = ['strategy_1', 'strategy_2', 'strategy_3a', 'strategy_4_1a', 'strategy_4_2a'] as const

export type StrategyId = (typeof VALID_STRATEGY_IDS)[number]
