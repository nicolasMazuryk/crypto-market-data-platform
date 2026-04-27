import { getResultsTsvPath, getStateJsonPath } from '../paths.js'
import type { ResultRow, RunState } from '../types.js'

import { reconstructState, readState, writeState } from './state.js'
import { readTsv } from './tsv.js'

export interface ResumeContext {
  tsvRows: ResultRow[]
  state: RunState
  iterStart: number
  complete: boolean
}

/**
 * Reconcile TSV + state.json. TSV is authoritative. If state.json is stale,
 * rewrite it from the TSV.
 */
export function reconcileState(repoRoot: string, tag: string): ResumeContext {
  const tsvPath = getResultsTsvPath(repoRoot, tag)
  const statePath = getStateJsonPath(repoRoot, tag)
  const rows = readTsv(tsvPath)

  const rebuilt = reconstructState(tag, rows)
  const existing = readState(statePath)

  let state: RunState = rebuilt
  if (existing !== null) {
    const agrees =
      existing.iter_count === rebuilt.iter_count &&
      existing.best_pnl === rebuilt.best_pnl &&
      existing.best_commit === rebuilt.best_commit &&
      existing.last_keep_commit === rebuilt.last_keep_commit &&
      existing.baseline_commit === rebuilt.baseline_commit
    if (!agrees) {
      writeState(statePath, rebuilt)
    } else {
      state = existing
    }
  } else {
    writeState(statePath, rebuilt)
  }

  const iterStart = rebuilt.iter_count
  return { tsvRows: rows, state, iterStart, complete: false }
}
