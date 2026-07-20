/** Strategy direction */
export type StrategyDirection = 'long' | 'short'

/** Take-profit mode for Strategy 3 */
export type TpMode = 'A' | 'B'

/**
 * Terminal-state enums for a trade. Canonical §12.1/§12.2 vocabulary lives in the shared
 * enum module; re-exported here so existing `../config/schema.js` importers keep working.
 */
import type { ErrorCode } from '../../config/canonical/enums.js'
export type { ExitReason, ErrorCode } from '../../config/canonical/enums.js'

/** Result shape for a representable terminal reached via a failure/no-fill path (§12.2). */
export interface BacktestError {
  error_code: ErrorCode
}

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

/**
 * Backtest-only simulation params (§10.2 bridge table rows with no live representation).
 * `stop_order_slippage` (formerly nested under `slippage`) is folded into
 * `market_slippage_pct` — same concept, canonical percent unit.
 */
export interface BacktestOnlyConfig {
  /** Slippage applied to stop/limit fills, in percent (e.g. 0.05 for 0.05%) */
  market_slippage_pct: number
  /** Simulated order placement latency */
  order_latency_ms: number
  /** Fraction of WS funding-fee events assumed missed by the live engine's fallback path */
  ws_event_miss_rate: number
  /** Extra delay seconds added to WS-gated exits to approximate fallback timeout behavior */
  ws_exit_extra_delay_seconds: number
  /** Lookahead window (seconds) to search for the price-drop candle */
  drop_search_window_seconds: number
  /** Funding-rate multiplier used to qualify a settlement price-drop candidate */
  drop_qualifier_funding_mult: number
  /** Candle range multiplier used to qualify a settlement price-drop candidate */
  drop_qualifier_range_mult: number
}

/** Base config shared by all strategies */
export interface BaseConfig extends BacktestOnlyConfig {
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
  /** Reporting config */
  reporting: ReportingConfig
  /** Funding settlement detection config */
  funding_settlement: FundingSettlementConfig
}

/** Strategy 1: Negative Funding LONG - Instant Exit */
export interface Strategy1Config {
  strategy_id: 'strategy_1'
  direction: 'long'
  /** Signed funding-rate percent threshold, e.g. -0.4 for -0.4% (canonical: negative_funding_threshold_percent) */
  negative_funding_threshold_percent: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Seconds after T_funding to exit (>= 2, market-order latency) */
  exit_offset_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
  /** Notional size in USD */
  amount_usd: number
  /** Leverage multiplier */
  leverage: number
}

/** Strategy 2: Negative Funding LONG - Retracement Exit */
export interface Strategy2Config {
  strategy_id: 'strategy_2'
  direction: 'long'
  negative_funding_threshold_percent: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Retracement level (0-1, e.g., 0.50 for 50%) */
  retracement_pct: number
  /** Max seconds after T_funding before forced exit (2..180) */
  deadline_seconds: number
  /** Stop-loss multiplier: SL at entry_price × (1 − |F| × sl_multiplier) */
  sl_multiplier: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
  /** Notional size in USD */
  amount_usd: number
  /** Leverage multiplier */
  leverage: number
}

/** Strategy 3: Negative Funding SHORT - Ride the Drop */
export interface Strategy3Config {
  strategy_id: 'strategy_3a'
  direction: 'short'
  negative_funding_threshold_percent: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Stop-loss distance in PERCENT (e.g., 1.0 for 1%; canonical: stop_loss_percent) */
  stop_loss_percent: number
  /** Take-profit mode: A = F*1.5, B = F+0.004 */
  tp_mode: TpMode
  /** TP multiplier for mode A (e.g., 1.5; canonical: tp_variant_a_multiplier) */
  tp_multiplier: number
  /** TP addend in PERCENT for variant B (e.g., 0.4 for 0.4%) */
  tp_addend_pct: number
  /** Max seconds after T_funding before forced exit (>= 2) */
  deadline_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
  /** Notional size in USD */
  amount_usd: number
  /** Leverage multiplier */
  leverage: number
}

/** Strategy 4.1: Negative Funding Ladder LONG - Post-Funding Entry */
export interface Strategy41Config {
  strategy_id: 'strategy_4_1a'
  direction: 'long'
  negative_funding_threshold_percent: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Number of limit orders in the ladder (>= 2) */
  ladder_count: number
  /** Multiplier for top of ladder range */
  ladder_top_mult: number
  /** Multiplier for bottom of ladder range */
  ladder_bottom_mult: number
  /** Take-profit in PERCENT above average entry (e.g., 0.2 for 0.2%; canonical: take_profit_pct) */
  take_profit_pct: number
  /** Max seconds after T_funding before forced exit (2..180) */
  deadline_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
  /** Stop-loss multiplier: SL at P_avg × (1 − |F| × sl_multiplier) */
  sl_multiplier: number
  /** Notional size in USD */
  amount_usd: number
  /** Leverage multiplier */
  leverage: number
}

/** Strategy 4.2: Negative Funding Single LONG - Post-Funding Entry */
export interface Strategy42Config {
  strategy_id: 'strategy_4_2a'
  direction: 'long'
  negative_funding_threshold_percent: number
  /** Seconds before T_funding to enter (>= 2, market-order latency) */
  entry_offset_seconds: number
  /** Multiplier for limit price offset */
  limit_offset_mult: number
  /** Take-profit in PERCENT above fill price (e.g., 0.2 for 0.2%; canonical: take_profit_pct) */
  take_profit_pct: number
  /** Max seconds after T_funding before forced exit (2..180) */
  deadline_seconds: number
  /** Whether to apply funding when entry or exit timestamp equals funding timestamp */
  funding_applied_on_same_second: boolean
  /** Stop-loss multiplier: SL at entry_price × (1 − |F| × sl_multiplier); must be > limit_offset_mult */
  sl_multiplier: number
  /** Notional size in USD */
  amount_usd: number
  /** Leverage multiplier */
  leverage: number
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
