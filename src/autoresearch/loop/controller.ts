import fs from 'fs'
import path from 'path'

import { commitExists, isAncestor, resetHard, revParseHead } from '../git/ratchet.js'
import { createTagLogger, stripAnsi } from '../logging.js'
import { getLockPath, getLogPath, getResultsTsvPath, getStateJsonPath } from '../paths.js'
import { writeState } from '../results/state.js'
import { reconcileState } from '../results/resume.js'
import { appendRow, ensureTsv } from '../results/tsv.js'
import type { ResultRow, RunSpec, RunState } from '../types.js'
import { acquireLock } from '../worktree/lock.js'
import { ensureWorktree } from '../worktree/manager.js'

import { runBaselineIteration, runIteration } from './iteration.js'
import type { Semaphore } from './pool.js'

const CONSECUTIVE_ERROR_THRESHOLD = 5
const RECENT_ROWS_IN_PROMPT = 100

export interface RunControllerOptions {
  repoRoot: string
  spec: RunSpec
  programMdPath: string
  chSemaphore: Semaphore
  baselineOnly?: boolean
  abortSignal?: AbortSignal
}

export interface RunControllerResult {
  tag: string
  iterations: number
  bestPnl: number | null
  bestCommit: string | null
  status: 'complete' | 'aborted' | 'error'
  finalState: RunState
}

function writeLogLine(logPath: string, line: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, line)
}

/**
 * Drive one matrix row to completion: set up the worktree, reconcile resume
 * state, then run iterations until the cap, an abort, or the consecutive
 * error threshold.
 */
export async function runController(opts: RunControllerOptions): Promise<RunControllerResult> {
  const { repoRoot, spec } = opts
  const lockPath = getLockPath(repoRoot, spec.tag)
  const lock = await acquireLock(lockPath)

  try {
    return await runControllerLocked(opts)
  } finally {
    await lock.release()
  }
}

async function runControllerLocked(opts: RunControllerOptions): Promise<RunControllerResult> {
  const { repoRoot, spec, programMdPath, chSemaphore } = opts
  const logger = createTagLogger(repoRoot, spec.tag)
  const logPath = getLogPath(repoRoot, spec.tag)
  const logWrite = (line: string): void => {
    writeLogLine(logPath, stripAnsi(line))
  }

  const statePath = getStateJsonPath(repoRoot, spec.tag)
  const tsvPath = getResultsTsvPath(repoRoot, spec.tag)

  const handle = await ensureWorktree({ repoRoot, spec })
  logger.info(
    { worktree: handle.worktreePath, branch: handle.branch, baseline: handle.baselineCommit },
    'worktree ready'
  )

  // Initial TSV bootstrap.
  ensureTsv(tsvPath)
  let { state, tsvRows } = reconcileState(repoRoot, spec.tag)

  // Seed baseline_commit if missing.
  if (state.baseline_commit === null) {
    state = { ...state, baseline_commit: handle.baselineCommit }
    writeState(statePath, state)
  }

  // If TSV has no baseline row yet, run iter 0.
  const baselineExists = tsvRows.some(row => row.iter === 0)
  if (!baselineExists) {
    const baselineRow = await runBaselineIteration({
      repoRoot,
      worktreePath: handle.worktreePath,
      spec,
      chSemaphore,
      logWrite,
    })
    appendRow(tsvPath, baselineRow)
    tsvRows = [...tsvRows, baselineRow]
    state = applyRowToState(state, baselineRow)
    writeState(statePath, state)
    logger.info({ row: baselineRow }, 'baseline iteration complete')
  }

  if (opts.baselineOnly === true) {
    return {
      tag: spec.tag,
      iterations: state.iter_count,
      bestPnl: state.best_pnl,
      bestCommit: state.best_commit,
      status: 'complete',
      finalState: state,
    }
  }

  // If worktree HEAD drifted from last keep, only hard-reset when it diverged.
  // If HEAD is simply ahead (e.g. maintenance/cherry-pick commit), keep it.
  if (state.last_keep_commit !== null) {
    const exists = await commitExists(handle.worktreePath, state.last_keep_commit)
    if (exists) {
      const head = await revParseHead(handle.worktreePath)
      if (head !== state.last_keep_commit) {
        const headAheadOfKeep = await isAncestor(handle.worktreePath, state.last_keep_commit, head)
        if (headAheadOfKeep) {
          logger.info(
            { head, last_keep_commit: state.last_keep_commit },
            'worktree HEAD is ahead of last keep; preserving newer commits'
          )
        } else {
          await resetHard(handle.worktreePath, state.last_keep_commit)
          logger.warn({ from: head, to: state.last_keep_commit }, 'worktree HEAD reset to last keep')
        }
      }
    }
  }

  const baselinePnl = tsvRows.find(row => row.iter === 0)?.total_net_pnl ?? null
  let iter = state.iter_count

  while (iter < spec.iterations) {
    if (opts.abortSignal?.aborted === true) {
      logger.info({ iter }, 'abort requested; stopping loop')
      return {
        tag: spec.tag,
        iterations: state.iter_count,
        bestPnl: state.best_pnl,
        bestCommit: state.best_commit,
        status: 'aborted',
        finalState: state,
      }
    }

    const recent = tsvRows.slice(-RECENT_ROWS_IN_PROMPT)
    const row = await runIteration({
      iter,
      iterations: spec.iterations,
      repoRoot,
      worktreePath: handle.worktreePath,
      programMdPath,
      spec,
      state,
      recentRows: recent,
      baselinePnl,
      chSemaphore,
      logWrite,
    })
    appendRow(tsvPath, row)
    tsvRows = [...tsvRows, row]
    state = applyRowToState(state, row)
    writeState(statePath, state)
    logger.info({ iter, status: row.status, pnl: row.total_net_pnl }, 'iteration complete')

    if (state.consecutive_errors >= CONSECUTIVE_ERROR_THRESHOLD) {
      logger.error(
        { consecutive_errors: state.consecutive_errors },
        'consecutive error threshold tripped; stopping loop'
      )
      const finalState: RunState = { ...state, status: 'error' }
      writeState(statePath, finalState)
      return {
        tag: spec.tag,
        iterations: state.iter_count,
        bestPnl: state.best_pnl,
        bestCommit: state.best_commit,
        status: 'error',
        finalState,
      }
    }

    iter += 1
  }

  const finalState: RunState = { ...state, status: 'complete' }
  writeState(statePath, finalState)
  return {
    tag: spec.tag,
    iterations: state.iter_count,
    bestPnl: state.best_pnl,
    bestCommit: state.best_commit,
    status: 'complete',
    finalState,
  }
}

function applyRowToState(state: RunState, row: ResultRow): RunState {
  const next: RunState = {
    ...state,
    iter_count: Math.max(state.iter_count, row.iter + 1),
    status: 'running',
    updated_at: new Date().toISOString(),
  }

  if (row.iter === 0 && row.commit_hash.length > 0) {
    next.baseline_commit = row.commit_hash
  }

  if (row.status === 'keep') {
    next.last_keep_commit = row.commit_hash
    if (row.total_net_pnl !== null && (state.best_pnl === null || row.total_net_pnl > state.best_pnl)) {
      next.best_pnl = row.total_net_pnl
      next.best_commit = row.commit_hash
    } else if (state.best_pnl === null && row.total_net_pnl !== null) {
      next.best_pnl = row.total_net_pnl
      next.best_commit = row.commit_hash
    }
    next.consecutive_errors = 0
  } else if (row.status === 'error') {
    next.consecutive_errors = state.consecutive_errors + 1
  } else {
    next.consecutive_errors = 0
  }
  return next
}
