#!/usr/bin/env tsx
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const RESULTS_DIR = join(REPO_ROOT, '.autoresearch', 'results')
const OUTPUT_DIR = join(REPO_ROOT, 'autoresearch', 'best-configs')

interface StateJson {
  tag: string
  best_commit: string | null
  best_pnl: number | null
}

type RowStatus = 'written' | 'skipped: no best commit' | 'skipped: file not in commit'

interface Row {
  tag: string
  best_pnl: number | null
  best_commit: string | null
  output_path: string
  status: RowStatus
}

function parseStrategy(tag: string): string {
  // Split on last '-' to handle tags like strategy_5-binance_bybit
  const idx = tag.lastIndexOf('-')
  return tag.slice(0, idx)
}

function shortSha(commit: string): string {
  return commit.slice(0, 7)
}

function gitShow(commit: string, path: string): string | null {
  try {
    return execSync(`git show ${commit}:${path}`, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString()
  } catch {
    return null
  }
}

if (!existsSync(RESULTS_DIR)) {
  console.error(`Results directory not found: ${RESULTS_DIR}`)
  process.exit(2)
}

// Wipe output dir so stale tags don't linger
if (existsSync(OUTPUT_DIR)) {
  rmSync(OUTPUT_DIR, { recursive: true, force: true })
}

const tags = readdirSync(RESULTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()

if (tags.length === 0) {
  console.error('No tags found in results directory.')
  process.exit(2)
}

const rows: Row[] = []
let writtenCount = 0

for (const tag of tags) {
  const stateFile = join(RESULTS_DIR, tag, 'state.json')
  if (!existsSync(stateFile)) continue

  const state: StateJson = JSON.parse(readFileSync(stateFile, 'utf8'))
  const strategy = parseStrategy(tag)
  const configPath = `config/strategies/${strategy}.yaml`
  const outputPath = join(OUTPUT_DIR, tag, configPath)

  if (!state.best_commit) {
    rows.push({ tag, best_pnl: null, best_commit: null, output_path: outputPath, status: 'skipped: no best commit' })
    continue
  }

  const content = gitShow(state.best_commit, configPath)
  if (content === null) {
    rows.push({
      tag,
      best_pnl: state.best_pnl,
      best_commit: state.best_commit,
      output_path: outputPath,
      status: 'skipped: file not in commit',
    })
    continue
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, content)
  writtenCount++
  rows.push({
    tag,
    best_pnl: state.best_pnl,
    best_commit: state.best_commit,
    output_path: outputPath,
    status: 'written',
  })
}

// Print summary table
const colWidths = {
  tag: Math.max(3, ...rows.map(r => r.tag.length)),
  pnl: 8,
  commit: 7,
  status: Math.max(6, ...rows.map(r => r.status.length)),
}

const hr = `${'─'.repeat(colWidths.tag + 2)}┼${'─'.repeat(colWidths.pnl + 2)}┼${'─'.repeat(colWidths.commit + 2)}┼${'─'.repeat(colWidths.status + 2)}`
const header = ` ${'tag'.padEnd(colWidths.tag)} │ ${'best_pnl'.padEnd(colWidths.pnl)} │ ${'commit'.padEnd(colWidths.commit)} │ ${'status'.padEnd(colWidths.status)} `

console.log('')
console.log(header)
console.log(hr)
for (const r of rows) {
  const pnl = r.best_pnl !== null ? r.best_pnl.toFixed(4) : '—'
  const commit = r.best_commit ? shortSha(r.best_commit) : '—'
  console.log(
    ` ${r.tag.padEnd(colWidths.tag)} │ ${pnl.padEnd(colWidths.pnl)} │ ${commit.padEnd(colWidths.commit)} │ ${r.status.padEnd(colWidths.status)} `
  )
}
console.log('')
console.log(`${writtenCount} written, ${rows.length - writtenCount} skipped → ${OUTPUT_DIR}`)
console.log('')

if (writtenCount === 0) {
  process.exit(1)
}
