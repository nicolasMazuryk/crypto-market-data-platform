import { loadConfig } from './config/loader.js'
import { runBacktestEngine } from './engine/backtest-runner.js'
import { formatReport } from './reporting/formatter.js'
import type { BacktestReport } from './reporting/types.js'
import type { TradeResult } from './strategies/types.js'

export interface BacktestResult {
  report: BacktestReport
  trades: TradeResult[]
  reportPath: string
}

/**
 * Run a complete backtest for a given strategy config.
 *
 * @param strategyConfigPath - Path to the strategy YAML config
 * @param baseConfigPath - Optional path to base config (defaults to config/base_config.yaml)
 * @returns BacktestResult with report, trades, and file path
 */
export async function runBacktest(strategyConfigPath: string, baseConfigPath?: string): Promise<BacktestResult> {
  const config = loadConfig(strategyConfigPath, baseConfigPath)
  const { report, trades } = await runBacktestEngine(config)
  const reportPath = formatReport(report, config.base.reporting.output_dir)
  return { report, trades, reportPath }
}

// Re-export types for external use
export type { BacktestReport } from './reporting/types.js'
export type { TradeResult } from './strategies/types.js'
export type { ResolvedConfig } from './config/schema.js'
