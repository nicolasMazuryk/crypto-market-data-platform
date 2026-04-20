import fs from 'fs'
import path from 'path'

import type { ResultRow, RunState } from '../types.js'

export function readState(statePath: string): RunState | null {
  if (!fs.existsSync(statePath)) return null
  const content = fs.readFileSync(statePath, 'utf-8')
  const parsed = JSON.parse(content) as RunState
  return parsed
}

export function writeState(statePath: string, state: RunState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp.${String(process.pid)}`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, statePath)
}

/** Reconstruct state from TSV rows. */
export function reconstructState(tag: string, rows: ResultRow[]): RunState {
  let best_pnl: number | null = null
  let best_commit: string | null = null
  let last_keep_commit: string | null = null
  let baseline_commit: string | null = null
  let consecutive_errors = 0

  const sorted = [...rows].sort((a, b) => a.iter - b.iter)

  for (const row of sorted) {
    if (row.iter === 0 && row.commit_hash.length > 0) {
      baseline_commit = row.commit_hash
    }
    if (row.status === 'keep') {
      last_keep_commit = row.commit_hash
      if (row.total_net_pnl !== null && (best_pnl === null || row.total_net_pnl > best_pnl)) {
        best_pnl = row.total_net_pnl
        best_commit = row.commit_hash
      }
      consecutive_errors = 0
    } else if (row.status === 'error') {
      consecutive_errors += 1
    } else {
      consecutive_errors = 0
    }
  }

  const iter_count = sorted.length === 0 ? 0 : (sorted[sorted.length - 1]?.iter ?? -1) + 1

  return {
    tag,
    iter_count,
    best_pnl,
    best_commit,
    last_keep_commit,
    baseline_commit,
    consecutive_errors,
    status: 'pending',
    updated_at: new Date().toISOString(),
  }
}
