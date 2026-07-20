import crypto from 'crypto'

import type { ResolvedConfig, ErrorCode } from '../config/schema.js'
import { EXIT_REASONS, ERROR_CODES } from '../../config/canonical/enums.js'
import type { SkipReason } from '../data/types.js'
import type { TradeResult } from '../strategies/types.js'
import type {
  BacktestReport,
  TradeStats,
  ReturnMetrics,
  WinLossMetrics,
  PnlDecomposition,
  RiskMetrics,
  ExitReasonDistribution,
  ErrorCodeDistribution,
  DataQualitySection,
  ReproducibilitySection,
  TradeLogEntry,
} from './types.js'
import * as m from './metrics.js'
import { computeEquityCurveMetrics } from './equity-curve-metrics.js'

interface BuildReportInput {
  config: ResolvedConfig
  trades: TradeResult[]
  /** Representable terminals reached via failure/no-fill paths (§12.2), one per emitted code. */
  errorCodes?: ErrorCode[]
  totalEventsScanned: number
  skipReasons: SkipReason[]
  triggeredCount: number
  unfilledCount: number
  tradesOpenAtEnd?: number
  dataRowCount: number
  gitCommit: string | null
}

export function buildReport(input: BuildReportInput): BacktestReport {
  const {
    config,
    trades,
    errorCodes = [],
    totalEventsScanned,
    skipReasons,
    triggeredCount,
    unfilledCount,
    tradesOpenAtEnd = 0,
    dataRowCount,
    gitCommit,
  } = input

  // Trade stats
  const skipReasonCounts: Record<string, number> = {}
  for (const reason of skipReasons) {
    skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1
  }

  const tradeStats: TradeStats = {
    total_funding_events: totalEventsScanned,
    events_skipped: skipReasons.length,
    skip_reasons: skipReasonCounts,
    events_triggered: triggeredCount,
    trades_executed: trades.length,
    unfilled_events: unfilledCount,
    trades_open_at_end: tradesOpenAtEnd,
  }

  // Return metrics
  const pnls = trades.map(t => t.pnl.net_pnl)
  const returnMetrics: ReturnMetrics = {
    total_net_pnl: pnls.reduce((s, v) => s + v, 0),
    mean_net_pnl: m.mean(pnls),
    median_net_pnl: m.median(pnls),
    std_dev: m.stdDev(pnls),
    skewness: m.skewness(pnls),
    kurtosis: m.kurtosis(pnls),
    best_trade: pnls.length > 0 ? Math.max(...pnls) : 0,
    worst_trade: pnls.length > 0 ? Math.min(...pnls) : 0,
  }

  // Win/loss
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p < 0)
  const winLoss: WinLossMetrics = {
    win_rate: pnls.length > 0 ? wins.length / pnls.length : 0,
    avg_win: wins.length > 0 ? m.mean(wins) : 0,
    avg_loss: losses.length > 0 ? m.mean(losses.map(Math.abs)) : 0,
    profit_factor: m.profitFactor(pnls),
    expectancy: m.expectancy(pnls),
  }

  // P&L decomposition
  const aggDelta = trades.reduce((s, t) => s + t.pnl.delta_pnl, 0)
  const aggFunding = trades.reduce((s, t) => s + t.pnl.funding_pnl, 0)
  const aggFees = trades.reduce((s, t) => s + t.pnl.fees, 0)
  const totalNet = returnMetrics.total_net_pnl
  const pnlDecomp: PnlDecomposition = {
    aggregate_delta_pnl: aggDelta,
    aggregate_funding_pnl: aggFunding,
    aggregate_fees: aggFees,
    funding_ratio: totalNet !== 0 ? aggFunding / totalNet : 0,
  }

  // Equity curve (cumulative P&L)
  const equityCurve: number[] = []
  const equityCurveTimestamps: string[] = []
  let cumPnl = 0
  for (const trade of trades) {
    cumPnl += trade.pnl.net_pnl
    equityCurve.push(cumPnl)
    equityCurveTimestamps.push(trade.funding_time.toISOString())
  }

  // Equity curve metrics
  const equityCurveMetrics = computeEquityCurveMetrics(equityCurve)

  // Risk metrics
  const ddResult = m.maxDrawdown(equityCurve)
  const riskMetrics: RiskMetrics = {
    max_drawdown_pct: ddResult.maxDrawdownPct,
    max_drawdown_duration_seconds: ddResult.maxDrawdownDurationSeconds,
    sharpe_ratio: m.sharpeRatio(pnls),
    sortino_ratio: m.sortinoRatio(pnls),
    calmar_ratio: m.calmarRatio(pnls, ddResult.maxDrawdownPct),
  }

  // Exit reason distribution (all §12.1 reasons, zero-filled for unused ones)
  const exitReasonDist: ExitReasonDistribution = {} as ExitReasonDistribution
  for (const reason of EXIT_REASONS) {
    const count = trades.filter(t => t.exit_reason === reason).length
    exitReasonDist[reason] = {
      count,
      pct: trades.length > 0 ? count / trades.length : 0,
    }
  }

  // Error code distribution (all §12.2 codes, zero-filled for unused ones)
  const errorCodeDist: ErrorCodeDistribution = {} as ErrorCodeDistribution
  for (const code of ERROR_CODES) {
    const count = errorCodes.filter(c => c === code).length
    errorCodeDist[code] = {
      count,
      pct: errorCodes.length > 0 ? count / errorCodes.length : 0,
    }
  }

  // Data quality
  const dataQuality: DataQualitySection = {
    total_events_scanned: totalEventsScanned,
    events_skipped_by_reason: skipReasonCounts,
    data_coverage_pct: totalEventsScanned > 0 ? (totalEventsScanned - skipReasons.length) / totalEventsScanned : 0,
    actual_date_range: {
      start: trades.length > 0 ? (trades[0]?.funding_time.toISOString() ?? '') : '',
      end: trades.length > 0 ? (trades[trades.length - 1]?.funding_time.toISOString() ?? '') : '',
    },
    configured_date_range: {
      start: config.base.start_date,
      end: config.base.end_date,
    },
  }

  // Reproducibility
  const configStr = JSON.stringify(config)
  const configHash = crypto.createHash('sha256').update(configStr).digest('hex')
  const reproducibility: ReproducibilitySection = {
    config_hash: configHash,
    data_row_count: dataRowCount,
    run_timestamp: new Date().toISOString(),
    git_commit: gitCommit,
  }

  // Trade log
  let tradeLog: TradeLogEntry[] | undefined
  if (config.base.reporting.include_trade_log) {
    tradeLog = trades.map(t => ({
      timestamp: t.funding_time.toISOString(),
      symbol: t.symbol,
      exchange: t.exchange,
      trigger_funding_rate: t.funding_rate,
      cumulative_funding_rate: t.cumulative_funding_rate ?? t.funding_rate,
      funding_events_collected: t.funding_events_collected ?? 1,
      delta_pnl: t.pnl.delta_pnl,
      spread_pnl: t.pnl.spread_pnl,
      funding_pnl: t.pnl.funding_pnl,
      fees: t.pnl.fees,
      net_pnl: t.pnl.net_pnl,
      exit_reason: t.exit_reason,
      hold_duration: t.hold_duration,
    }))
  }

  return {
    strategy_id: config.strategy.strategy_id,
    trade_stats: tradeStats,
    return_metrics: returnMetrics,
    win_loss: winLoss,
    pnl_decomposition: pnlDecomp,
    risk_metrics: riskMetrics,
    exit_reason_distribution: exitReasonDist,
    error_code_distribution: errorCodeDist,
    data_quality: dataQuality,
    reproducibility: reproducibility,
    trade_log: tradeLog,
    equity_curve: equityCurve,
    equity_curve_timestamps: equityCurveTimestamps,
    equity_curve_metrics: equityCurveMetrics,
  }
}
