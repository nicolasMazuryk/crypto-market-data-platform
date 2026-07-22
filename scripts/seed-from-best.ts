#!/usr/bin/env tsx
/**
 * Copies best-configs into worktree config files so autoresearch starts from
 * known-good parameters instead of iteration-0 baselines.
 *
 * When the config differs from worktree HEAD the script:
 *   1. Commits the change in the worktree using the autoresearch commit format
 *   2. Appends a 'keep' row to results.tsv (copying metrics from the best row)
 *      so reconstructState derives last_keep_commit = new commit
 *   3. Rewrites state.json to match the TSV-derived state exactly
 *
 * Usage:
 *   tsx scripts/seed-from-best.ts --strategy strategy_1
 *   tsx scripts/seed-from-best.ts --tags strategy_1-binance,strategy_1-bybit
 *   tsx scripts/seed-from-best.ts --strategy strategy_1 --dry-run
 */
import { execSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const BEST_CONFIGS_DIR = join(REPO_ROOT, 'autoresearch', 'best-configs')
const WORKTREES_DIR = join(REPO_ROOT, '.autoresearch', 'worktrees')
const RESULTS_DIR = join(REPO_ROOT, '.autoresearch', 'results')

// ── types (mirrors src/autoresearch/types.ts) ─────────────────────────────────

interface ResultRow {
  iter: number
  timestamp: string
  commit_hash: string
  total_net_pnl: number | null
  sharpe: number | null
  win_rate: number | null
  trades: number | null
  ulcer_index: number | null
  equity_curve_quality_score: number | null
  status: 'keep' | 'discard' | 'error'
  description: string
  report_path: string
  duration_s: number
  error_message: string
  tokens_used: number | null
  cost_usd: number | null
}

interface RunState {
  tag: string
  iter_count: number
  best_pnl: number | null
  best_commit: string | null
  last_keep_commit: string | null
  baseline_commit: string | null
  consecutive_errors: number
  status: string
  updated_at: string
}

// ── TSV helpers ───────────────────────────────────────────────────────────────

const TSV_HEADER =
  'iter\ttimestamp\tcommit_hash\ttotal_net_pnl\tsharpe\twin_rate\ttrades\tulcer_index\tequity_curve_quality_score\tstatus\tdescription\treport_path\tduration_s\terror_message\ttokens_used\tcost_usd'

function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return ''
  return String(v)
}

function formatRow(r: ResultRow): string {
  return [
    String(r.iter),
    r.timestamp,
    r.commit_hash,
    fmt(r.total_net_pnl),
    fmt(r.sharpe),
    fmt(r.win_rate),
    r.trades === null ? '' : String(r.trades),
    fmt(r.ulcer_index),
    fmt(r.equity_curve_quality_score),
    r.status,
    r.description.replace(/[\t\r\n]/g, ' '),
    r.report_path.replace(/[\t\r\n]/g, ' '),
    fmt(r.duration_s),
    r.error_message.replace(/[\t\r\n]/g, ' '),
    fmt(r.tokens_used),
    fmt(r.cost_usd),
  ].join('\t')
}

function parseTsvRows(tsvPath: string): ResultRow[] {
  if (!existsSync(tsvPath)) return []
  const lines = readFileSync(tsvPath, 'utf8')
    .split('\n')
    .filter(l => l.length > 0)
  if (lines.length <= 1) return []
  const rows: ResultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const f = (lines[i] as string).split('\t')
    // Support 12-col legacy, 14-col mid, and 16-col current formats
    const numCols = f.length
    if (numCols < 12) continue
    const iter = Number(f[0])
    const timestamp = f[1] as string
    const commit_hash = f[2] as string
    const total_net_pnl = f[3] === '' ? null : Number(f[3])
    const sharpe = f[4] === '' ? null : Number(f[4])
    const win_rate = f[5] === '' ? null : Number(f[5])
    const trades = f[6] === '' ? null : Number(f[6])
    let ulcer_index: number | null = null
    let equity_curve_quality_score: number | null = null
    let status: string
    let description: string
    let report_path: string
    let duration_s: number
    let error_message: string
    let tokens_used: number | null = null
    let cost_usd: number | null = null

    if (numCols === 12) {
      // legacy
      status = f[7] as string
      description = f[8] as string
      report_path = f[9] as string
      duration_s = Number(f[10])
      error_message = f[11] as string
    } else if (numCols === 14) {
      // mid
      ulcer_index = f[7] === '' ? null : Number(f[7])
      equity_curve_quality_score = f[8] === '' ? null : Number(f[8])
      status = f[9] as string
      description = f[10] as string
      report_path = f[11] as string
      duration_s = Number(f[12])
      error_message = f[13] as string
    } else {
      // current (16 cols)
      ulcer_index = f[7] === '' ? null : Number(f[7])
      equity_curve_quality_score = f[8] === '' ? null : Number(f[8])
      status = f[9] as string
      description = f[10] as string
      report_path = f[11] as string
      duration_s = Number(f[12])
      error_message = f[13] as string
      tokens_used = f[14] === '' ? null : Number(f[14])
      cost_usd = f[15] === '' ? null : Number(f[15])
    }

    if (status !== 'keep' && status !== 'discard' && status !== 'error') continue
    rows.push({
      iter,
      timestamp,
      commit_hash,
      total_net_pnl,
      sharpe,
      win_rate,
      trades,
      ulcer_index,
      equity_curve_quality_score,
      status: status as ResultRow['status'],
      description,
      report_path,
      duration_s,
      error_message,
      tokens_used,
      cost_usd,
    })
  }
  return rows
}

function appendTsvRow(tsvPath: string, row: ResultRow): void {
  if (!existsSync(tsvPath)) {
    mkdirSync(dirname(tsvPath), { recursive: true })
    writeFileSync(tsvPath, `${TSV_HEADER}\n`)
  }
  writeFileSync(tsvPath, `${formatRow(row)}\n`, { flag: 'a' })
}

// ── state helpers ─────────────────────────────────────────────────────────────

function readState(statePath: string): RunState | null {
  if (!existsSync(statePath)) return null
  return JSON.parse(readFileSync(statePath, 'utf8')) as RunState
}

function writeState(statePath: string, state: RunState): void {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

/** Mirrors reconstructState in src/autoresearch/results/state.ts */
function reconstructState(tag: string, rows: ResultRow[]): RunState {
  let best_pnl: number | null = null
  let best_commit: string | null = null
  let last_keep_commit: string | null = null
  let baseline_commit: string | null = null
  let consecutive_errors = 0

  const sorted = [...rows].sort((a, b) => a.iter - b.iter)
  for (const row of sorted) {
    if (row.iter === 0 && row.commit_hash.length > 0) baseline_commit = row.commit_hash
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
    status: 'running',
    updated_at: new Date().toISOString(),
  }
}

// ── git helpers ───────────────────────────────────────────────────────────────

function gitStatusClean(worktreePath: string): boolean {
  const out = execSync('git status --porcelain', { cwd: worktreePath }).toString()
  return out.trim() === ''
}

function gitHead(worktreePath: string): string {
  return execSync('git rev-parse HEAD', { cwd: worktreePath }).toString().trim()
}

function gitCommit(worktreePath: string, message: string): string {
  execSync('git add -A', { cwd: worktreePath })
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: worktreePath })
  return gitHead(worktreePath)
}

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseStrategy(tag: string): string {
  return tag.slice(0, tag.lastIndexOf('-'))
}

function parseArgs(): { tags: string[]; dryRun: boolean } {
  const args = process.argv.slice(2)
  let tags: string[] = []
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tags' && args[i + 1]) {
      tags = (args[++i] as string)
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
    } else if (args[i] === '--strategy' && args[i + 1]) {
      const strategy = args[++i] as string
      if (!existsSync(BEST_CONFIGS_DIR)) {
        console.error(`Best-configs directory not found: ${BEST_CONFIGS_DIR}`)
        process.exit(2)
      }
      tags = readdirSync(BEST_CONFIGS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith(`${strategy}-`))
        .map(d => d.name)
        .sort()
      if (tags.length === 0) {
        console.error(`No best-config entries found for strategy: ${strategy}`)
        process.exit(2)
      }
    } else if (args[i] === '--dry-run') {
      dryRun = true
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage:
  tsx scripts/seed-from-best.ts --strategy <strategy>
  tsx scripts/seed-from-best.ts --tags <tag1,tag2,...>
  tsx scripts/seed-from-best.ts --strategy <strategy> --dry-run

When the config differs from worktree HEAD:
  - Commits the change with the autoresearch commit message format
  - Appends a keep row to results.tsv with the new commit hash
  - Rewrites state.json to match the updated TSV state
`)
      process.exit(0)
    }
  }

  if (tags.length === 0) {
    console.error('Error: provide --strategy <name> or --tags <tag1,tag2,...>')
    process.exit(1)
  }

  return { tags, dryRun }
}

// ── main ──────────────────────────────────────────────────────────────────────

type RowStatus =
  | 'no-change'
  | 'committed + tsv + state updated'
  | 'would commit (dry-run)'
  | 'skipped: no best-config'
  | 'skipped: no worktree'

interface Row {
  tag: string
  newCommit: string | null
  status: RowStatus
}

const { tags, dryRun } = parseArgs()
const rows: Row[] = []
let actionCount = 0

for (const tag of tags) {
  const strategy = parseStrategy(tag)
  const relPath = `config/strategies/${strategy}.yaml`
  const src = join(BEST_CONFIGS_DIR, tag, relPath)
  const worktreePath = join(WORKTREES_DIR, tag)
  const dst = join(worktreePath, relPath)
  const tsvPath = join(RESULTS_DIR, tag, 'results.tsv')
  const statePath = join(RESULTS_DIR, tag, 'state.json')

  if (!existsSync(src)) {
    rows.push({ tag, newCommit: null, status: 'skipped: no best-config' })
    continue
  }

  if (!existsSync(worktreePath)) {
    rows.push({ tag, newCommit: null, status: 'skipped: no worktree' })
    continue
  }

  // Copy config into worktree
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)

  if (gitStatusClean(worktreePath)) {
    // Nothing changed — worktree HEAD already has the best config
    rows.push({ tag, newCommit: null, status: 'no-change' })
    continue
  }

  // There are changes — need to commit + update artifacts
  if (dryRun) {
    rows.push({ tag, newCommit: null, status: 'would commit (dry-run)' })
    actionCount++
    continue
  }

  // Read existing TSV and state (before the commit)
  const tsvRows = parseTsvRows(tsvPath)
  const existingState = readState(statePath)
  const iterCount = existingState?.iter_count ?? tsvRows.length

  // Commit in worktree with autoresearch message format
  const commitMsg = `autoresearch ${tag} iter ${String(iterCount)}: seed from best config`
  const seedCommit = gitCommit(worktreePath, commitMsg)

  // If there are existing TSV rows, append a keep row so reconstructState
  // derives last_keep_commit = seedCommit. Copy metrics from the best row.
  if (tsvRows.length > 0) {
    const bestRow = tsvRows
      .filter(r => r.status === 'keep' && r.total_net_pnl !== null)
      .sort((a, b) => (b.total_net_pnl ?? 0) - (a.total_net_pnl ?? 0))[0]

    const seedRow: ResultRow = {
      iter: iterCount,
      timestamp: new Date().toISOString(),
      commit_hash: seedCommit,
      total_net_pnl: bestRow?.total_net_pnl ?? null,
      sharpe: bestRow?.sharpe ?? null,
      win_rate: bestRow?.win_rate ?? null,
      trades: bestRow?.trades ?? null,
      ulcer_index: bestRow?.ulcer_index ?? null,
      equity_curve_quality_score: bestRow?.equity_curve_quality_score ?? null,
      status: 'keep',
      description: 'seed from best config',
      report_path: bestRow?.report_path ?? '',
      duration_s: 0,
      error_message: '',
      tokens_used: null,
      cost_usd: null,
    }
    appendTsvRow(tsvPath, seedRow)

    // Rewrite state.json to match what reconcileState will derive from the updated TSV
    const updatedRows = [...tsvRows, seedRow]
    const newState = reconstructState(tag, updatedRows)
    // Preserve the existing status field if already set
    const stateToWrite: RunState = {
      ...newState,
      status: existingState?.status ?? 'running',
    }
    writeState(statePath, stateToWrite)
  }

  actionCount++
  rows.push({ tag, newCommit: seedCommit, status: 'committed + tsv + state updated' })
}

// ── summary table ─────────────────────────────────────────────────────────────

const colWidths = {
  tag: Math.max(3, ...rows.map(r => r.tag.length)),
  commit: 9,
  status: Math.max(6, ...rows.map(r => r.status.length)),
}

const hr = `${'─'.repeat(colWidths.tag + 2)}┼${'─'.repeat(colWidths.commit + 2)}┼${'─'.repeat(colWidths.status + 2)}`
const header = ` ${'tag'.padEnd(colWidths.tag)} │ ${'commit'.padEnd(colWidths.commit)} │ ${'status'.padEnd(colWidths.status)} `

console.log('')
console.log(header)
console.log(hr)
for (const r of rows) {
  const commit = r.newCommit ? r.newCommit.slice(0, 7) : '—'.padEnd(7)
  console.log(
    ` ${r.tag.padEnd(colWidths.tag)} │ ${commit.padEnd(colWidths.commit)} │ ${r.status.padEnd(colWidths.status)} `
  )
}
console.log('')

const skipped = rows.filter(r => r.status.startsWith('skipped')).length
const noChange = rows.filter(r => r.status === 'no-change').length
const verb = dryRun ? 'would commit' : 'committed'
console.log(`${actionCount} ${verb}, ${noChange} no-change, ${skipped} skipped`, dryRun ? '(dry-run)' : '')
console.log('')

if (skipped > 0 && actionCount === 0 && noChange === 0) {
  process.exit(1)
}
