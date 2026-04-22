import fs from 'fs'

import type { BacktestReport } from '../../backtesting/reporting/types.js'
import type { BacktestMetrics } from '../types.js'

export function parseReport(reportPath: string): BacktestReport {
  const content = fs.readFileSync(reportPath, 'utf-8')
  const parsed = JSON.parse(content) as BacktestReport
  return parsed
}

function toFinite(val: number): number {
  if (!Number.isFinite(val)) {
    // sharpe/profit_factor can be Infinity when there are no losses, or NaN
    // when there are no trades. Map both to 0 so the TSV stays comparable.
    return 0
  }
  return val
}

export function extractMetrics(report: BacktestReport): BacktestMetrics {
  const ecm = report.equity_curve_metrics
  return {
    total_net_pnl: toFinite(report.return_metrics.total_net_pnl),
    sharpe: toFinite(report.risk_metrics.sharpe_ratio),
    win_rate: toFinite(report.win_loss.win_rate),
    trades: report.trade_stats.trades_executed,
    ulcer_index: ecm != null ? toFinite(ecm.ulcer_index) : null,
    equity_curve_quality_score: ecm != null ? toFinite(ecm.equity_curve_quality_score) : null,
  }
}
