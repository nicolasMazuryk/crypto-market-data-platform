import type { ExitReason, ErrorCode } from '../config/schema.js'

/** Trade statistics */
export interface TradeStats {
  total_funding_events: number
  events_skipped: number
  skip_reasons: Record<string, number>
  events_triggered: number
  trades_executed: number
  unfilled_events: number
  /** Positions still open when backtest data ran out (no exit signal fired). */
  trades_open_at_end: number
}

/** Return metrics */
export interface ReturnMetrics {
  total_net_pnl: number
  mean_net_pnl: number
  median_net_pnl: number
  std_dev: number
  skewness: number
  kurtosis: number
  best_trade: number
  worst_trade: number
}

/** Win/loss metrics */
export interface WinLossMetrics {
  win_rate: number
  avg_win: number
  avg_loss: number
  profit_factor: number
  expectancy: number
}

/** P&L decomposition */
export interface PnlDecomposition {
  aggregate_delta_pnl: number
  aggregate_funding_pnl: number
  aggregate_fees: number
  funding_ratio: number
}

/** Risk metrics */
export interface RiskMetrics {
  max_drawdown_pct: number
  max_drawdown_duration_seconds: number
  sharpe_ratio: number
  sortino_ratio: number
  calmar_ratio: number
}

/** Exit reason distribution */
export type ExitReasonDistribution = Record<ExitReason, { count: number; pct: number }>

/** Error code distribution (representable terminals reached via failure/no-fill paths, §12.2) */
export type ErrorCodeDistribution = Record<ErrorCode, { count: number; pct: number }>

/** Data quality section */
export interface DataQualitySection {
  total_events_scanned: number
  events_skipped_by_reason: Record<string, number>
  data_coverage_pct: number
  actual_date_range: { start: string; end: string }
  configured_date_range: { start: string; end: string }
}

/** Reproducibility section */
export interface ReproducibilitySection {
  config_hash: string
  data_row_count: number
  run_timestamp: string
  git_commit: string | null
}

/** Enriched, report-facing shape for a no-position terminal (§12.2 error_code). */
export interface ErrorLogEntry {
  exchange: string
  symbol: string
  funding_time: Date
  funding_rate: number
  error_code: ErrorCode
  t_drop_offset_s: number | null
}

/**
 * Per-event audit log entry (§10.3). Every triggered funding event that reached a terminal
 * state gets one entry — a trade or a no-position error — with `exit_reason` XOR `error_code`
 * set. P&L fields are percent (×100 of the internal fraction-based `PnlBreakdown`).
 */
export interface TradeLogEntry {
  timestamp: string
  symbol: string
  exchange: string
  /** Funding rate of the trigger event (single event). */
  trigger_funding_rate: number
  /** Sum of all collected funding rates across the carry period. */
  cumulative_funding_rate: number | null
  /** Number of funding events accrued during the carry period. */
  funding_events_collected: number | null
  /** Price change P&L, percent. */
  delta_pnl: number | null
  /** Spread P&L, percent. */
  spread_pnl: number | null
  /** Funding fee P&L, percent. */
  funding_pnl: number | null
  /** Total fees, percent. */
  fees: number | null
  /** Net P&L, percent. */
  net_pnl: number | null
  exit_reason: ExitReason | null
  error_code: ErrorCode | null
  hold_duration: number | null
  fill_count: number | null
  funding_received: boolean | null
  t_drop_offset_s: number | null
}

/** Single item in the §14 conservatism report. */
export interface ConservatismItem {
  key: string
  description: string
  active: boolean
  estimated_bias_pct: number | null
  /** Why bias is null, or the measurement basis, when relevant. */
  note?: string
}

export type ConservatismReport = ConservatismItem[]

/** Per-metric scores for equity curve quality */
export interface EquityCurveScores {
  r2: number
  k_ratio: number
  ulcer_index: number
  recovery_factor: number
  serenity_ratio: number
  gain_to_pain_ratio: number
}

/** Equity curve shape and quality metrics */
export interface EquityCurveMetrics {
  r2: number
  k_ratio: number
  ulcer_index: number
  recovery_factor: number
  serenity_ratio: number
  gain_to_pain_ratio: number
  scores: EquityCurveScores
  equity_curve_quality_score: number
}

/** Aggregate stats for one drop-offset bucket. */
export interface DropOffsetBucket {
  count: number
  total_net_pnl: number
  mean_net_pnl: number
}

/** §16 bucketing of net_pnl by whether the (fixed-clock) exit preceded T_drop. */
export interface DropOffsetBucketing {
  /** Exit fired before T_drop: t_drop_offset_s > exit_offset_seconds (favorable). */
  exit_before_drop: DropOffsetBucket
  /** Exit fired at/after/inside the drop: t_drop_offset_s <= exit_offset_seconds. */
  exit_after_or_inside_drop: DropOffsetBucket
  /** No qualifying drop localized (t_drop_offset_s === null). */
  no_drop_localized: DropOffsetBucket
}

/** Complete backtest report */
export interface BacktestReport {
  strategy_id: string
  trade_stats: TradeStats
  return_metrics: ReturnMetrics
  win_loss: WinLossMetrics
  pnl_decomposition: PnlDecomposition
  risk_metrics: RiskMetrics
  exit_reason_distribution: ExitReasonDistribution
  error_code_distribution: ErrorCodeDistribution
  data_quality: DataQualitySection
  reproducibility: ReproducibilitySection
  trade_log?: TradeLogEntry[] | undefined
  conservatism: ConservatismReport
  equity_curve: number[]
  equity_curve_timestamps: string[]
  equity_curve_metrics: EquityCurveMetrics | null
  drop_offset_bucketing?: DropOffsetBucketing | undefined
}
