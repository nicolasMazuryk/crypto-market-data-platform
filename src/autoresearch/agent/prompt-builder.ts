import fs from 'fs'
import path from 'path'

import type { Proposal } from './proposal.js'
import { allowedEditPathsForStrategy, getProposalsDir, strategyDocFamily } from '../paths.js'
import type { ResultRow, RunSpec } from '../types.js'

export interface BuildPromptOptions {
  repoRoot: string
  worktreePath: string
  spec: RunSpec
  programMdPath: string
  strategyYamlPath: string
  iter: number
  iterations: number
  bestPnl: number | null
  baselinePnl: number | null
  recentRows: ResultRow[]
  proposalPath: string
}

function readFileSafe(filePath: string): string {
  if (!fs.existsSync(filePath)) return ''
  return fs.readFileSync(filePath, 'utf-8')
}

function describeMatrixRow(spec: RunSpec): string {
  if (spec.exchange !== null) {
    return `strategy=${spec.strategy} exchange=${spec.exchange}`
  }
  return `strategy=${spec.strategy} exchange_a=${spec.exchange_a ?? '?'} exchange_b=${spec.exchange_b ?? '?'}`
}

function compactRow(row: ResultRow, rationale?: string): string {
  const pnl = row.total_net_pnl === null ? 'n/a' : row.total_net_pnl.toFixed(6)
  const sharpe = row.sharpe === null ? 'n/a' : row.sharpe.toFixed(3)
  const trades = row.trades === null ? 'n/a' : String(row.trades)
  const ecq = row.equity_curve_quality_score === null ? 'n/a' : row.equity_curve_quality_score.toFixed(1)
  const ui = row.ulcer_index === null ? 'n/a' : row.ulcer_index.toFixed(3)
  let line = `  iter=${String(row.iter)} status=${row.status} pnl=${pnl} sharpe=${sharpe} trades=${trades} ecq=${ecq} ui=${ui} desc="${row.description}"`
  if (row.status === 'error' && row.error_message.length > 0) {
    line += ` error="${row.error_message.replace(/"/g, "'")}"`
  }
  if (rationale !== undefined && rationale.length > 0) {
    line += ` rationale="${rationale.replace(/"/g, "'")}"`
  }
  return line
}

function loadProposalHistory(proposalsDir: string, rows: ResultRow[]): Map<number, Proposal> {
  const map = new Map<number, Proposal>()
  if (!fs.existsSync(proposalsDir)) return map
  for (const row of rows) {
    const filePath = path.join(proposalsDir, `iter_${String(row.iter)}.json`)
    if (!fs.existsSync(filePath)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Proposal
      if (typeof parsed.rationale === 'string') map.set(row.iter, parsed)
    } catch {
      // ignore parse errors
    }
  }
  return map
}

/**
 * Build the agent prompt. The stable prefix (program.md + schema excerpt +
 * pinned constraints) comes first so Anthropic's prompt cache can match it
 * across iterations; the variable suffix (history, current YAML, iter counter)
 * comes last.
 */
export function buildPrompt(opts: BuildPromptOptions): string {
  const program = readFileSafe(opts.programMdPath)
  const currentYaml = readFileSafe(opts.strategyYamlPath)
  const allowed = allowedEditPathsForStrategy(opts.spec.strategy)
  const relativeYamlPath = path.relative(opts.worktreePath, opts.strategyYamlPath)

  const docFamily = strategyDocFamily(opts.spec.strategy)

  const stablePrefix = [
    '# autoresearch: strategy-tuning agent',
    '',
    '## Run identity',
    `tag: ${opts.spec.tag}`,
    `matrix_row: ${describeMatrixRow(opts.spec)}`,
    `allowed_edit_paths: ${allowed.join(', ')}`,
    `docs_for_this_run: docs-strategy/strategies/${docFamily}.md`,
    '',
    '## Instructions (program.md)',
    program.trim(),
    '',
    '## Hard constraints',
    `- Edit ONLY: ${allowed.join(', ')}. Do not touch any other file.`,
    '- Do not create new files.',
    opts.spec.strategy === 'strategy_5'
      ? `- strategy_5 pins: exchange_a=${opts.spec.exchange_a ?? '?'} exchange_b=${opts.spec.exchange_b ?? '?'} — these fields must NOT change.`
      : '- (No pinned fields for this strategy.)',
    `- Also write a proposal file at ${opts.proposalPath} containing JSON: {"rationale": string, "summary": string}.`,
    '- "summary" must be a single short line describing the diff; it goes into the results TSV as the iteration description.',
    '- You may run ONLY the read-only shell commands listed in program.md (cat, head, grep, ssh, npm run remote:clickhouse:query, etc.). Do not run git, rm, package installs, or any write-path command.',
    '',
  ].join('\n')

  const proposalsDir = getProposalsDir(opts.repoRoot, opts.spec.tag)
  const proposalHistory = loadProposalHistory(proposalsDir, opts.recentRows)

  const history =
    opts.recentRows.length === 0
      ? '  (none yet — this is the first-or-baseline iteration)'
      : opts.recentRows.map(row => compactRow(row, proposalHistory.get(row.iter)?.rationale)).join('\n')

  const variableSuffix = [
    '## Iteration context',
    `iter_number: ${String(opts.iter)} of ${String(opts.iterations)}`,
    `baseline_total_net_pnl: ${opts.baselinePnl === null ? 'n/a' : opts.baselinePnl.toFixed(6)}`,
    `best_total_net_pnl_so_far: ${opts.bestPnl === null ? 'n/a' : opts.bestPnl.toFixed(6)}`,
    '',
    '## Recent results — last 100 rows (most recent last)',
    history,
    '',
    `## Current ${relativeYamlPath}`,
    '```yaml',
    currentYaml.trim(),
    '```',
    '',
    '## Your task',
    `Propose ONE edit to ${relativeYamlPath} that is likely to increase total_net_pnl.`,
    `Then write ${opts.proposalPath} with your rationale and a one-line summary.`,
    'Do not produce further commentary outside of the edits and the proposal file.',
  ].join('\n')

  return `${stablePrefix}\n${variableSuffix}\n`
}
