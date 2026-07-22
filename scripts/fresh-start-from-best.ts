#!/usr/bin/env tsx
/**
 * Reseeds every autoresearch tag's worktree with its best-known config, then
 * wipes that tag's iteration history (results.tsv/state.json/reports/log) so
 * the next orchestrate run starts a fresh iter 0 from the seeded commit
 * instead of resetting the worktree back to whatever is on main.
 *
 * Usage:
 *   tsx scripts/fresh-start-from-best.ts
 *   tsx scripts/fresh-start-from-best.ts --tags strategy_1-binance,strategy_2-bybit
 *   tsx scripts/fresh-start-from-best.ts --dry-run
 */
import { execSync } from 'child_process'
import { copyFileSync, existsSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { loadMatrix, toRunSpec } from '../src/autoresearch/matrix/loader.js'
import { ensureWorktree } from '../src/autoresearch/worktree/manager.js'
import type { RunSpec } from '../src/autoresearch/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const BEST_CONFIGS_DIR = join(REPO_ROOT, 'autoresearch', 'best-configs')
const MATRIX_PATH = join(REPO_ROOT, 'autoresearch', 'matrix.yaml')

type RowStatus =
  | 'seeded (new worktree)'
  | 'seeded (recreated worktree)'
  | 'no-change (already best)'
  | 'would seed (dry-run)'
  | 'skipped: no best-config'

interface Row {
  tag: string
  commit: string | null
  status: RowStatus
}

function parseArgs(): { tags: string[] | null; dryRun: boolean } {
  const args = process.argv.slice(2)
  let tags: string[] | null = null
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tags' && args[i + 1]) {
      tags = (args[++i] as string)
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
    } else if (args[i] === '--dry-run') {
      dryRun = true
    }
  }
  return { tags, dryRun }
}

function gitStatusClean(worktreePath: string): boolean {
  return execSync('git status --porcelain', { cwd: worktreePath }).toString().trim() === ''
}

function gitHead(worktreePath: string): string {
  return execSync('git rev-parse HEAD', { cwd: worktreePath }).toString().trim()
}

function gitCommit(worktreePath: string, message: string): string {
  execSync('git add -A', { cwd: worktreePath })
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: worktreePath })
  return gitHead(worktreePath)
}

async function main(): Promise<void> {
  const { tags: tagFilter, dryRun } = parseArgs()

  const matrix = loadMatrix(MATRIX_PATH)
  let specs: RunSpec[] = matrix.runs.map(row => toRunSpec(row, matrix))
  if (tagFilter !== null) {
    const wanted = new Set(tagFilter)
    specs = specs.filter(s => wanted.has(s.tag))
    const missing = tagFilter.filter(t => !specs.some(s => s.tag === t))
    if (missing.length > 0) {
      console.error(`Tag(s) not in matrix: ${missing.join(', ')}`)
      process.exit(1)
    }
  }

  const rows: Row[] = []

  for (const spec of specs) {
    const relPath = `config/strategies/${spec.strategy}.yaml`
    const src = join(BEST_CONFIGS_DIR, spec.tag, relPath)

    if (!existsSync(src)) {
      rows.push({ tag: spec.tag, commit: null, status: 'skipped: no best-config' })
      continue
    }

    if (dryRun) {
      rows.push({ tag: spec.tag, commit: null, status: 'would seed (dry-run)' })
      continue
    }

    const worktreeExistedBefore = existsSync(join(REPO_ROOT, '.autoresearch', 'worktrees', spec.tag))
    // reset: true recreates the worktree from current main HEAD (not just reuses
    // whatever stale branch/code was there before) so seeded configs are
    // validated against today's schema, not a possibly ancient one.
    const handle = await ensureWorktree({ repoRoot: REPO_ROOT, spec, reset: true })

    const dst = join(handle.worktreePath, relPath)
    copyFileSync(src, dst)

    if (gitStatusClean(handle.worktreePath)) {
      rows.push({ tag: spec.tag, commit: handle.baselineCommit, status: 'no-change (already best)' })
      continue
    }

    const commit = gitCommit(handle.worktreePath, `autoresearch ${spec.tag}: reseed from best config (fresh start)`)
    rows.push({
      tag: spec.tag,
      commit,
      status: worktreeExistedBefore ? 'seeded (recreated worktree)' : 'seeded (new worktree)',
    })
  }

  if (!dryRun) {
    for (const spec of specs) {
      const resultsDir = join(REPO_ROOT, '.autoresearch', 'results', spec.tag)
      if (existsSync(resultsDir)) rmSync(resultsDir, { recursive: true, force: true })
      const reportsDir = join(REPO_ROOT, '.autoresearch', 'reports', spec.tag)
      if (existsSync(reportsDir)) rmSync(reportsDir, { recursive: true, force: true })
      const logPath = join(REPO_ROOT, '.autoresearch', 'logs', `${spec.tag}.log`)
      if (existsSync(logPath)) rmSync(logPath, { force: true })
    }
    const dashboardPath = join(REPO_ROOT, '.autoresearch', 'dashboard.json')
    if (existsSync(dashboardPath)) rmSync(dashboardPath, { force: true })
  }

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
    const commit = r.commit ? r.commit.slice(0, 7) : '—'.padEnd(7)
    console.log(` ${r.tag.padEnd(colWidths.tag)} │ ${commit.padEnd(colWidths.commit)} │ ${r.status.padEnd(colWidths.status)} `)
  }
  console.log('')

  const seeded = rows.filter(r => r.status.startsWith('seeded')).length
  const noChange = rows.filter(r => r.status.startsWith('no-change')).length
  const skipped = rows.filter(r => r.status.startsWith('skipped')).length
  const verb = dryRun ? 'would seed' : 'seeded'
  console.log(`${dryRun ? rows.filter(r => r.status.startsWith('would')).length : seeded} ${verb}, ${noChange} no-change, ${skipped} skipped`)
  if (!dryRun) {
    console.log('Iteration history (results.tsv/state.json/reports/logs) wiped for all selected tags.')
  }
  console.log('')

  if (skipped === rows.length) {
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[fresh-start-from-best] fatal: ${message}`)
  process.exit(1)
})
