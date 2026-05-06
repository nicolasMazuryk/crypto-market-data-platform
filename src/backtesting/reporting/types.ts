import type { ExitReason } from '../config/schema.js'

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

/** Per-trade log entry */
export interface TradeLogEntry {
  timestamp: string
  symbol: string
  exchange: string
  /** Funding rate of the trigger event (single event). */
  trigger_funding_rate: number
  /** Sum of all collected funding rates across the carry period. */
  cumulative_funding_rate: number
  /** Number of funding events accrued during the carry period. */
  funding_events_collected: number
  delta_pnl: number
  spread_pnl: number
  funding_pnl: number
  fees: number
  net_pnl: number
  exit_reason: ExitReason
  hold_duration: number
}

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

/** Complete backtest report */
export interface BacktestReport {
  strategy_id: string
  trade_stats: TradeStats
  return_metrics: ReturnMetrics
  win_loss: WinLossMetrics
  pnl_decomposition: PnlDecomposition
  risk_metrics: RiskMetrics
  exit_reason_distribution: ExitReasonDistribution
  data_quality: DataQualitySection
  reproducibility: ReproducibilitySection
  trade_log?: TradeLogEntry[] | undefined
  equity_curve: number[]
  equity_curve_timestamps: string[]
  equity_curve_metrics: EquityCurveMetrics | null
}
