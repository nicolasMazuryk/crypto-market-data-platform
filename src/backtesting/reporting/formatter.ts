import fs from 'fs'
import path from 'path'

import type { BacktestReport } from './types.js'

/** Write report to JSON file and print summary to console */
export function formatReport(report: BacktestReport, outputDir: string): string {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `${report.strategy_id}_${timestamp}.json`
  const filepath = path.join(outputDir, filename)

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2))

  // Console summary
  const ts = report.trade_stats
  const rm = report.return_metrics
  const wl = report.win_loss
  const risk = report.risk_metrics
  const decomp = report.pnl_decomposition

  const lines = [
    '',
    `=== Backtest Report: ${report.strategy_id} ===`,
    '',
    `--- Trade Statistics ---`,
    `  Total events scanned:  ${String(ts.total_funding_events)}`,
    `  Events skipped:        ${String(ts.events_skipped)}`,
    `  Events triggered:      ${String(ts.events_triggered)}`,
    `  Trades executed:       ${String(ts.trades_executed)}`,
    `  Unfilled events:       ${String(ts.unfilled_events)}`,
    '',
    `--- Returns ---`,
    `  Total Net P&L:    ${(rm.total_net_pnl * 100).toFixed(4)}%`,
    `  Mean P&L/trade:   ${(rm.mean_net_pnl * 100).toFixed(4)}%`,
    `  Median P&L/trade: ${(rm.median_net_pnl * 100).toFixed(4)}%`,
    `  Std Dev:          ${(rm.std_dev * 100).toFixed(4)}%`,
    `  Best trade:       ${(rm.best_trade * 100).toFixed(4)}%`,
    `  Worst trade:      ${(rm.worst_trade * 100).toFixed(4)}%`,
    '',
    `--- Win/Loss ---`,
    `  Win rate:       ${(wl.win_rate * 100).toFixed(2)}%`,
    `  Avg win:        ${(wl.avg_win * 100).toFixed(4)}%`,
    `  Avg loss:       ${(wl.avg_loss * 100).toFixed(4)}%`,
    `  Profit factor:  ${wl.profit_factor === Infinity ? 'Inf' : wl.profit_factor.toFixed(4)}`,
    `  Expectancy:     ${(wl.expectancy * 100).toFixed(4)}%`,
    '',
    `--- P&L Decomposition ---`,
    `  Delta P&L:   ${(decomp.aggregate_delta_pnl * 100).toFixed(4)}%`,
    `  Funding P&L: ${(decomp.aggregate_funding_pnl * 100).toFixed(4)}%`,
    `  Fees:        ${(decomp.aggregate_fees * 100).toFixed(4)}%`,
    `  Funding ratio: ${(decomp.funding_ratio * 100).toFixed(2)}%`,
    '',
    `--- Risk ---`,
    `  Max drawdown:  ${(risk.max_drawdown_pct * 100).toFixed(4)}%`,
    `  Sharpe ratio:  ${risk.sharpe_ratio === Infinity ? 'Inf' : risk.sharpe_ratio.toFixed(4)}`,
    `  Sortino ratio: ${risk.sortino_ratio === Infinity ? 'Inf' : risk.sortino_ratio.toFixed(4)}`,
    `  Calmar ratio:  ${risk.calmar_ratio.toFixed(4)}`,
    '',
    `--- Exit Reasons ---`,
  ]

  for (const [reason, data] of Object.entries(report.exit_reason_distribution)) {
    if (data.count > 0) {
      lines.push(`  ${reason}: ${String(data.count)} (${(data.pct * 100).toFixed(1)}%)`)
    }
  }

  lines.push('')
  lines.push(`--- Equity Curve Metrics ---`)
  const ecm = report.equity_curve_metrics
  if (ecm === null) {
    lines.push(`  N/A (fewer than 3 equity points)`)
  } else {
    const fmt = (v: number) => (isFinite(v) ? v.toFixed(4) : v > 0 ? 'Inf' : '-Inf')
    lines.push(`  R²:                  ${fmt(ecm.r2)}  (score: ${ecm.scores.r2.toFixed(1)})`)
    lines.push(`  K-Ratio:             ${fmt(ecm.k_ratio)}  (score: ${ecm.scores.k_ratio.toFixed(1)})`)
    lines.push(`  Ulcer Index:         ${fmt(ecm.ulcer_index)}%  (score: ${ecm.scores.ulcer_index.toFixed(1)})`)
    lines.push(`  Recovery Factor:     ${fmt(ecm.recovery_factor)}  (score: ${ecm.scores.recovery_factor.toFixed(1)})`)
    lines.push(`  Serenity Ratio:      ${fmt(ecm.serenity_ratio)}  (score: ${ecm.scores.serenity_ratio.toFixed(1)})`)
    lines.push(
      `  Gain-to-Pain Ratio:  ${fmt(ecm.gain_to_pain_ratio)}  (score: ${ecm.scores.gain_to_pain_ratio.toFixed(1)})`
    )
    lines.push(`  Quality Score:       ${ecm.equity_curve_quality_score.toFixed(1)} / 100`)
  }

  lines.push('')
  lines.push(`Report saved to: ${filepath}`)
  lines.push('')

  const output = lines.join('\n')
  console.log(output)
  return filepath
}
