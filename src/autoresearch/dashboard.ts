import fs from 'fs'
import path from 'path'

import { getAutoresearchRoot, getDashboardJsonPath, getResultsTsvPath, getStateJsonPath } from './paths.js'
import { readState } from './results/state.js'
import { readTsv } from './results/tsv.js'

interface DashboardRow {
  tag: string
  iterations_completed: number
  best_pnl: number | null
  best_commit: string | null
  baseline_pnl: number | null
  last_status: string | null
  last_iter_timestamp: string | null
  keep_count: number
  discard_count: number
  error_count: number
}

export function buildDashboard(repoRoot: string): DashboardRow[] {
  const resultsRoot = path.join(getAutoresearchRoot(repoRoot), 'results')
  if (!fs.existsSync(resultsRoot)) return []
  const tags = fs.readdirSync(resultsRoot).filter(name => {
    const full = path.join(resultsRoot, name)
    return fs.statSync(full).isDirectory()
  })

  const rows: DashboardRow[] = []
  for (const tag of tags) {
    const tsvPath = getResultsTsvPath(repoRoot, tag)
    if (!fs.existsSync(tsvPath)) continue
    const tsv = readTsv(tsvPath)
    const state = readState(getStateJsonPath(repoRoot, tag))
    const last = tsv[tsv.length - 1]
    const baseline = tsv.find(r => r.iter === 0)
    const keep = tsv.filter(r => r.status === 'keep').length
    const discard = tsv.filter(r => r.status === 'discard').length
    const error = tsv.filter(r => r.status === 'error').length

    rows.push({
      tag,
      iterations_completed: state?.iter_count ?? tsv.length,
      best_pnl: state?.best_pnl ?? null,
      best_commit: state?.best_commit ?? null,
      baseline_pnl: baseline?.total_net_pnl ?? null,
      last_status: last?.status ?? null,
      last_iter_timestamp: last?.timestamp ?? null,
      keep_count: keep,
      discard_count: discard,
      error_count: error,
    })
  }
  rows.sort((a, b) => a.tag.localeCompare(b.tag))
  return rows
}

export function writeDashboard(repoRoot: string): string {
  const rows = buildDashboard(repoRoot)
  const dashPath = getDashboardJsonPath(repoRoot)
  fs.mkdirSync(path.dirname(dashPath), { recursive: true })
  fs.writeFileSync(dashPath, JSON.stringify({ generated_at: new Date().toISOString(), runs: rows }, null, 2))
  return dashPath
}
