import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { invokeAgent } from '../agent/invoke.js'
import { buildPrompt } from '../agent/prompt-builder.js'
import { clearProposal, readProposalSafe } from '../agent/proposal.js'
import { extractMetrics, parseReport } from '../backtest/parser.js'
import { runBacktest } from '../backtest/runner.js'
import { enforceScope } from '../git/diff-gate.js'
import { commitAll, diffNameOnlyHead, resetHard, revParseHead } from '../git/ratchet.js'
import { getProposalIterPath, getProposalJsonPath, getReportsDir, getResultsDir } from '../paths.js'
import { appendRow } from '../results/tsv.js'
import type { ResultRow, RunSpec, RunState } from '../types.js'
import { renderEquityCurveChart } from '../../backtesting/reporting/equity-curve-chart.js'
import type { BacktestReport } from '../../backtesting/reporting/types.js'

import type { Semaphore } from './pool.js'

export interface IterationDeps {
  repoRoot: string
  worktreePath: string
  programMdPath: string
  spec: RunSpec
  chSemaphore: Semaphore
  logWrite: (line: string) => void
}

export interface IterationArgs extends IterationDeps {
  iter: number
  iterations: number
  state: RunState
  /** Most-recent N rows to include in the agent prompt. */
  recentRows: ResultRow[]
  /** iter-0 baseline pnl (null until the baseline runs). */
  baselinePnl: number | null
}

function hashFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return ''
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

function strategyYamlPath(worktreePath: string, strategy: string): string {
  return path.join(worktreePath, 'config', 'strategies', `${strategy}.yaml`)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 3)}...`
}

function copyReport(srcReportPath: string, repoRoot: string, tag: string, iter: number): string {
  const reportsDir = getReportsDir(repoRoot, tag)
  fs.mkdirSync(reportsDir, { recursive: true })
  const dest = path.join(reportsDir, `iter_${String(iter)}.json`)
  fs.copyFileSync(srcReportPath, dest)
  return dest
}

/**
 * Run one propose → run → score → keep/revert cycle. Returns the appended
 * result row. The caller is responsible for updating state.json.
 */
export async function runIteration(args: IterationArgs): Promise<ResultRow> {
  const { iter, spec, repoRoot, worktreePath, chSemaphore, logWrite, state } = args
  const startedAt = Date.now()
  const timestamp = new Date().toISOString()
  const preIterationHead = await revParseHead(worktreePath)

  const yamlPath = strategyYamlPath(worktreePath, spec.strategy)
  const proposalPath = getProposalJsonPath(repoRoot, spec.tag)
  const beforeHash = hashFile(yamlPath)

  // Step 1: build prompt + invoke agent.
  const prompt = buildPrompt({
    repoRoot,
    worktreePath,
    spec,
    programMdPath: args.programMdPath,
    strategyYamlPath: yamlPath,
    iter,
    iterations: args.iterations,
    bestPnl: state.best_pnl,
    baselinePnl: args.baselinePnl,
    recentRows: args.recentRows,
    proposalPath,
  })

  clearProposal(proposalPath)
  fs.mkdirSync(getResultsDir(repoRoot, spec.tag), { recursive: true })

  const agentResult = await invokeAgent({
    agent: spec.agent,
    prompt,
    cwd: worktreePath,
    addDirs: [getResultsDir(repoRoot, spec.tag)],
    timeoutMs: spec.iteration_timeout_ms,
    logWrite,
  })

  if (agentResult.timedOut || agentResult.code !== 0) {
    // Defensive: revert any partial edits before recording error.
    await revertWorktreeToHead(worktreePath)
    const err = agentResult.timedOut ? 'agent_timeout' : `agent_exit_code=${String(agentResult.code)}`
    return buildErrorRow(iter, timestamp, preIterationHead, err, startedAt)
  }

  // Step 2: diff-gate.
  const gate = await enforceScope(worktreePath, spec)
  if (gate.errorMessage !== null) {
    return buildErrorRow(iter, timestamp, preIterationHead, gate.errorMessage, startedAt)
  }

  // Step 3: check for noop (YAML unchanged).
  const afterHash = hashFile(yamlPath)
  const { proposal, error: proposalError } = readProposalSafe(proposalPath)
  if (proposalError !== null) {
    await revertWorktreeToHead(worktreePath)
    return buildErrorRow(iter, timestamp, preIterationHead, `proposal_parse_error: ${proposalError}`, startedAt)
  }
  const summary = proposal?.summary ?? ''

  if (proposal !== null) {
    const proposalIterPath = getProposalIterPath(repoRoot, spec.tag, iter)
    fs.mkdirSync(path.dirname(proposalIterPath), { recursive: true })
    fs.writeFileSync(proposalIterPath, JSON.stringify(proposal, null, 2))
  }

  if (afterHash === beforeHash) {
    // No change at all — skip backtest entirely.
    return {
      iter,
      timestamp,
      commit_hash: preIterationHead,
      total_net_pnl: null,
      sharpe: null,
      win_rate: null,
      trades: null,
      ulcer_index: null,
      equity_curve_quality_score: null,
      status: 'noop',
      description: truncate(summary || 'no-op (yaml unchanged)', 240),
      report_path: '',
      duration_s: (Date.now() - startedAt) / 1000,
      error_message: '',
    }
  }

  // Step 4: run backtest.
  const reportsDir = getReportsDir(repoRoot, spec.tag)
  const backtest = await chSemaphore.withLease(() =>
    runBacktest({
      cwd: worktreePath,
      strategy: spec.strategy,
      reportsDir,
      timeoutMs: spec.backtest_timeout_ms,
      logWrite,
    })
  )

  if (backtest.timedOut || backtest.code !== 0 || backtest.reportPath === null) {
    // Backtest failed — revert YAML edits so we stay on last keep.
    await revertWorktreeToHead(worktreePath)
    const err = backtest.timedOut ? 'backtest_timeout' : `backtest_exit_code=${String(backtest.code)}`
    return buildErrorRow(iter, timestamp, preIterationHead, err, startedAt)
  }

  let metrics
  let report: BacktestReport
  try {
    report = parseReport(backtest.reportPath)
    metrics = extractMetrics(report)
  } catch (err) {
    await revertWorktreeToHead(worktreePath)
    const message = err instanceof Error ? err.message : String(err)
    return buildErrorRow(iter, timestamp, preIterationHead, `report_parse_error: ${message}`, startedAt)
  }

  // Copy the report into the per-iteration name so the TSV row points
  // somewhere stable.
  const iterReportPath = copyReport(backtest.reportPath, repoRoot, spec.tag, iter)
  await renderEquityCurveChart(report.equity_curve, iterReportPath.replace(/\.json$/, '.png')).catch((e: unknown) => {
    logWrite(`[chart] render failed: ${e instanceof Error ? e.message : String(e)}`)
  })

  // Step 5: decide keep/discard.
  const improved = state.best_pnl === null ? true : metrics.total_net_pnl > state.best_pnl
  let commitHash = state.last_keep_commit ?? ''
  let status: ResultRow['status']

  if (improved) {
    const description = truncate(summary || `iter ${String(iter)} keep`, 200)
    const message = `autoresearch ${spec.tag} iter ${String(iter)}: ${description}`
    commitHash = await commitAll(worktreePath, message)
    status = 'keep'
  } else {
    // Revert this attempt only (keep any maintenance commits already on HEAD).
    await resetHard(worktreePath, preIterationHead)
    commitHash = preIterationHead
    status = 'discard'
  }

  return {
    iter,
    timestamp,
    commit_hash: commitHash,
    total_net_pnl: metrics.total_net_pnl,
    sharpe: metrics.sharpe,
    win_rate: metrics.win_rate,
    trades: metrics.trades,
    ulcer_index: metrics.ulcer_index,
    equity_curve_quality_score: metrics.equity_curve_quality_score,
    status,
    description: truncate(summary || (status === 'keep' ? 'improved' : 'regressed'), 240),
    report_path: path.relative(repoRoot, iterReportPath),
    duration_s: (Date.now() - startedAt) / 1000,
    error_message: '',
  }
}

async function revertWorktreeToHead(worktreePath: string): Promise<void> {
  const changed = await diffNameOnlyHead(worktreePath)
  if (changed.length === 0) return
  await resetHard(worktreePath, 'HEAD')
}

function buildErrorRow(
  iter: number,
  timestamp: string,
  commitHash: string,
  errorMessage: string,
  startedAt: number
): ResultRow {
  return {
    iter,
    timestamp,
    commit_hash: commitHash,
    total_net_pnl: null,
    sharpe: null,
    win_rate: null,
    trades: null,
    ulcer_index: null,
    equity_curve_quality_score: null,
    status: 'error',
    description: '',
    report_path: '',
    duration_s: (Date.now() - startedAt) / 1000,
    error_message: errorMessage,
  }
}

/** Baseline iter-0: no agent, just run the backtest against the fresh worktree. */
export async function runBaselineIteration(args: {
  repoRoot: string
  worktreePath: string
  spec: RunSpec
  chSemaphore: Semaphore
  logWrite: (line: string) => void
}): Promise<ResultRow> {
  const { iter, timestamp, startedAt } = { iter: 0, timestamp: new Date().toISOString(), startedAt: Date.now() }
  const commit = await revParseHead(args.worktreePath)
  const reportsDir = getReportsDir(args.repoRoot, args.spec.tag)

  const backtest = await args.chSemaphore.withLease(() =>
    runBacktest({
      cwd: args.worktreePath,
      strategy: args.spec.strategy,
      reportsDir,
      timeoutMs: args.spec.backtest_timeout_ms,
      logWrite: args.logWrite,
    })
  )

  if (backtest.timedOut || backtest.code !== 0 || backtest.reportPath === null) {
    const err = backtest.timedOut ? 'backtest_timeout' : `backtest_exit_code=${String(backtest.code)}`
    return buildErrorRow(iter, timestamp, commit, err, startedAt)
  }

  let metrics
  let report: BacktestReport
  try {
    report = parseReport(backtest.reportPath)
    metrics = extractMetrics(report)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return buildErrorRow(iter, timestamp, commit, `report_parse_error: ${message}`, startedAt)
  }

  const iterReportPath = copyReport(backtest.reportPath, args.repoRoot, args.spec.tag, iter)
  await renderEquityCurveChart(report.equity_curve, iterReportPath.replace(/\.json$/, '.png')).catch((e: unknown) => {
    args.logWrite(`[chart] render failed: ${e instanceof Error ? e.message : String(e)}`)
  })

  return {
    iter,
    timestamp,
    commit_hash: commit,
    total_net_pnl: metrics.total_net_pnl,
    sharpe: metrics.sharpe,
    win_rate: metrics.win_rate,
    trades: metrics.trades,
    ulcer_index: metrics.ulcer_index,
    equity_curve_quality_score: metrics.equity_curve_quality_score,
    status: 'keep',
    description: 'baseline',
    report_path: path.relative(args.repoRoot, iterReportPath),
    duration_s: (Date.now() - startedAt) / 1000,
    error_message: '',
  }
}

export function appendIterationRow(repoRoot: string, tag: string, row: ResultRow): void {
  const tsvPath = path.join(repoRoot, '.autoresearch', 'results', tag, 'results.tsv')
  appendRow(tsvPath, row)
}
