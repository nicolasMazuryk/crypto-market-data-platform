import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runIteration } from '../loop/iteration.js'
import type { RunSpec, RunState } from '../types.js'

vi.mock('../agent/invoke.js')
vi.mock('../backtest/runner.js')
vi.mock('../git/diff-gate.js')
vi.mock('../git/ratchet.js')
vi.mock('../../backtesting/reporting/equity-curve-chart.js')

const { invokeAgent } = await import('../agent/invoke.js')
const { runBacktest } = await import('../backtest/runner.js')
const { enforceScope } = await import('../git/diff-gate.js')
const { commitAll, diffNameOnlyHead, resetHard, revParseHead } = await import('../git/ratchet.js')
const { renderEquityCurveChart, renderTimeBasedEquityCurveChart } =
  await import('../../backtesting/reporting/equity-curve-chart.js')

const FAKE_COMMIT = 'aabbccdd00112233aabbccdd00112233aabbccdd'
const TAG = 'strategy_1-binance'
const STRATEGY = 'strategy_1'

const YAML_V1 = 'strategy_id: strategy_1\nfunding_threshold: 0.004\nentry_offset_seconds: 3\nexit_offset_seconds: 2\n'
const YAML_V2 = 'strategy_id: strategy_1\nfunding_threshold: 0.006\nentry_offset_seconds: 3\nexit_offset_seconds: 2\n'

const FAKE_REPORT = {
  strategy_id: STRATEGY,
  trade_stats: {
    total_funding_events: 10,
    events_skipped: 0,
    skip_reasons: {},
    events_triggered: 5,
    trades_executed: 5,
    unfilled_events: 0,
  },
  return_metrics: {
    total_net_pnl: 0.05,
    mean_net_pnl: 0.01,
    median_net_pnl: 0.01,
    std_dev: 0.002,
    skewness: 0,
    kurtosis: 0,
    best_trade: 0.02,
    worst_trade: -0.005,
  },
  win_loss: { win_rate: 0.8, avg_win: 0.012, avg_loss: -0.005, profit_factor: 2.0, expectancy: 0.009 },
  pnl_decomposition: {
    aggregate_delta_pnl: 0.04,
    aggregate_funding_pnl: 0.015,
    aggregate_fees: -0.005,
    funding_ratio: 0.3,
  },
  risk_metrics: {
    max_drawdown_pct: 0.01,
    max_drawdown_duration_seconds: 3600,
    sharpe_ratio: 1.5,
    sortino_ratio: 2.0,
    calmar_ratio: 5.0,
  },
  exit_reason_distribution: {},
  data_quality: {
    total_events_scanned: 10,
    events_skipped_by_reason: {},
    data_coverage_pct: 1.0,
    actual_date_range: { start: '2025-01-01', end: '2025-03-01' },
    configured_date_range: { start: '2025-01-01', end: '2025-03-01' },
  },
  reproducibility: { config_hash: 'abc', data_row_count: 10, run_timestamp: '2025-01-01T00:00:00Z', git_commit: null },
  equity_curve: [0, 0.01, 0.02, 0.05],
  equity_curve_timestamps: [
    '2025-01-01T00:00:00Z',
    '2025-01-02T00:00:00Z',
    '2025-01-03T00:00:00Z',
    '2025-01-04T00:00:00Z',
  ],
  equity_curve_metrics: null,
}

function makeSpec(): RunSpec {
  return {
    tag: TAG,
    strategy: STRATEGY,
    exchange: 'binance',
    main_exchange: null,
    exclude_exchanges: null,
    iterations: 5,
    iteration_timeout_ms: 60_000,
    backtest_timeout_ms: 60_000,
    per_iteration_budget_usd: 1.0,
    agent: 'claude',
  }
}

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    tag: TAG,
    iter_count: 1,
    best_pnl: null,
    best_commit: null,
    last_keep_commit: null,
    baseline_commit: null,
    consecutive_errors: 0,
    status: 'running',
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function okAgentResult() {
  return { code: 0, durationMs: 100, timedOut: false, stdout: '', stderr: '', tokensUsed: 100, costUsd: 0.01 }
}

function okBacktestResult(reportPath: string) {
  return { code: 0, durationMs: 200, timedOut: false, stdout: '', stderr: '', reportPath }
}

let dir: string
let worktreePath: string
let proposalPath: string
let yamlPath: string
let programMdPath: string
let reportsDir: string

const semaphore = { withLease: <T>(fn: () => Promise<T>) => fn() }

beforeEach(() => {
  vi.clearAllMocks()

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iter-test-'))
  worktreePath = path.join(dir, 'worktrees', TAG)
  proposalPath = path.join(dir, '.autoresearch', 'results', TAG, 'proposal.json')
  yamlPath = path.join(worktreePath, 'config', 'strategies', `${STRATEGY}.yaml`)
  programMdPath = path.join(dir, 'program.md')
  reportsDir = path.join(dir, '.autoresearch', 'reports', TAG)

  fs.mkdirSync(path.join(worktreePath, 'config', 'strategies'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.autoresearch', 'results', TAG), { recursive: true })
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.writeFileSync(yamlPath, YAML_V1)
  fs.writeFileSync(programMdPath, '# program\ndo the thing')

  vi.mocked(revParseHead).mockResolvedValue(FAKE_COMMIT)
  vi.mocked(enforceScope).mockResolvedValue({ errorMessage: null })
  vi.mocked(diffNameOnlyHead).mockResolvedValue([])
  vi.mocked(resetHard).mockResolvedValue(undefined)
  vi.mocked(commitAll).mockResolvedValue(FAKE_COMMIT)
  vi.mocked(renderEquityCurveChart).mockResolvedValue(undefined)
  vi.mocked(renderTimeBasedEquityCurveChart).mockResolvedValue(undefined)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function setupBacktest() {
  const reportPath = path.join(reportsDir, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify(FAKE_REPORT))
  vi.mocked(runBacktest).mockResolvedValue(okBacktestResult(reportPath))
}

describe('runIteration — summary validation', () => {
  it('retries and succeeds when first summary is empty but retry provides a valid summary', async () => {
    let callCount = 0
    vi.mocked(invokeAgent).mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // First call: change YAML + empty summary
        fs.writeFileSync(yamlPath, YAML_V2)
        fs.writeFileSync(proposalPath, JSON.stringify({ rationale: 'test', summary: '' }))
      } else {
        // Summary retry: valid summary (YAML already changed)
        fs.writeFileSync(
          proposalPath,
          JSON.stringify({
            rationale: 'test',
            summary: 'funding_threshold 0.004 → 0.006 (widen filter to reduce noise)',
          })
        )
      }
      return okAgentResult()
    })
    setupBacktest()

    const row = await runIteration({
      iter: 1,
      iterations: 5,
      repoRoot: dir,
      worktreePath,
      programMdPath,
      spec: makeSpec(),
      chSemaphore: semaphore,
      logWrite: () => {},
      state: makeState(),
      recentRows: [],
      baselinePnl: null,
    })

    expect(callCount).toBe(2)
    expect(row.status).toBe('keep')
    expect(row.description).toContain('funding_threshold')
    expect(row.error_message).toBe('')
  })

  it('returns error row when both attempts have an invalid summary', async () => {
    let callCount = 0
    vi.mocked(invokeAgent).mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        fs.writeFileSync(yamlPath, YAML_V2)
      }
      // Both calls write an empty summary
      fs.writeFileSync(proposalPath, JSON.stringify({ rationale: 'test', summary: '' }))
      return okAgentResult()
    })

    const row = await runIteration({
      iter: 1,
      iterations: 5,
      repoRoot: dir,
      worktreePath,
      programMdPath,
      spec: makeSpec(),
      chSemaphore: semaphore,
      logWrite: () => {},
      state: makeState(),
      recentRows: [],
      baselinePnl: null,
    })

    expect(callCount).toBe(2)
    expect(row.status).toBe('error')
    expect(row.error_message).toMatch(/agent_missing_or_uninformative_summary/)
    expect(runBacktest).not.toHaveBeenCalled()
  })

  it('returns error row when both attempts have a placeholder summary', async () => {
    let callCount = 0
    vi.mocked(invokeAgent).mockImplementation(async () => {
      callCount++
      if (callCount === 1) fs.writeFileSync(yamlPath, YAML_V2)
      fs.writeFileSync(proposalPath, JSON.stringify({ rationale: 'test', summary: 'improved' }))
      return okAgentResult()
    })

    const row = await runIteration({
      iter: 1,
      iterations: 5,
      repoRoot: dir,
      worktreePath,
      programMdPath,
      spec: makeSpec(),
      chSemaphore: semaphore,
      logWrite: () => {},
      state: makeState(),
      recentRows: [],
      baselinePnl: null,
    })

    expect(row.status).toBe('error')
    expect(row.error_message).toMatch(/agent_missing_or_uninformative_summary/)
    expect(row.error_message).toMatch(/placeholder/)
  })

  it('does not retry summary when the first attempt provides a valid summary', async () => {
    let callCount = 0
    vi.mocked(invokeAgent).mockImplementation(async () => {
      callCount++
      fs.writeFileSync(yamlPath, YAML_V2)
      fs.writeFileSync(
        proposalPath,
        JSON.stringify({ rationale: 'test', summary: 'funding_threshold 0.004 → 0.006 (widen filter to reduce noise)' })
      )
      return okAgentResult()
    })
    setupBacktest()

    const row = await runIteration({
      iter: 1,
      iterations: 5,
      repoRoot: dir,
      worktreePath,
      programMdPath,
      spec: makeSpec(),
      chSemaphore: semaphore,
      logWrite: () => {},
      state: makeState(),
      recentRows: [],
      baselinePnl: null,
    })

    expect(callCount).toBe(1)
    expect(row.status).not.toBe('error')
    expect(row.description).toContain('funding_threshold')
  })
})
