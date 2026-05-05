export type IterationStatus = 'keep' | 'discard' | 'error'

export type AgentKind = 'claude' | 'codex'

export interface MatrixRowNonCross {
  strategy: string
  exchange: string
  iterations?: number
  agent: AgentKind
}

export interface MatrixRowCross {
  strategy: 'strategy_5'
  main_exchange: string
  exclude_exchanges: string[]
  iterations?: number
  agent: AgentKind
}

export type MatrixRow = MatrixRowNonCross | MatrixRowCross

export interface MatrixFile {
  default_iterations: number
  max_parallel: number
  max_parallel_backtests: number
  iteration_timeout_ms: number
  backtest_timeout_ms: number
  per_iteration_budget_usd: number
  runs: MatrixRow[]
}

export interface RunSpec {
  tag: string
  strategy: string
  exchange: string | null
  main_exchange: string | null
  exclude_exchanges: string[] | null
  iterations: number
  iteration_timeout_ms: number
  backtest_timeout_ms: number
  per_iteration_budget_usd: number
  agent: AgentKind
}

export interface ResultRow {
  iter: number
  timestamp: string
  commit_hash: string
  total_net_pnl: number | null
  sharpe: number | null
  win_rate: number | null
  trades: number | null
  ulcer_index: number | null
  equity_curve_quality_score: number | null
  status: IterationStatus
  description: string
  report_path: string
  duration_s: number
  error_message: string
  tokens_used: number | null
  cost_usd: number | null
}

export interface RunState {
  tag: string
  iter_count: number
  best_pnl: number | null
  best_commit: string | null
  last_keep_commit: string | null
  baseline_commit: string | null
  consecutive_errors: number
  status: 'pending' | 'running' | 'complete' | 'error'
  updated_at: string
}

export interface IterationOutcome {
  row: ResultRow
  kept: boolean
  bestPnl: number | null
  lastKeepCommit: string | null
}

export interface BacktestMetrics {
  total_net_pnl: number
  sharpe: number
  win_rate: number
  trades: number
  ulcer_index: number | null
  equity_curve_quality_score: number | null
}
