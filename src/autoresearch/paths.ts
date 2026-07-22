import path from 'path'

import type { MatrixRow } from './types.js'

export function getAutoresearchRoot(repoRoot: string): string {
  return path.join(repoRoot, '.autoresearch')
}

export function getWorktreePath(repoRoot: string, tag: string): string {
  return path.join(getAutoresearchRoot(repoRoot), 'worktrees', tag)
}

export function getResultsDir(repoRoot: string, tag: string): string {
  return path.join(getAutoresearchRoot(repoRoot), 'results', tag)
}

export function getResultsTsvPath(repoRoot: string, tag: string): string {
  return path.join(getResultsDir(repoRoot, tag), 'results.tsv')
}

export function getStateJsonPath(repoRoot: string, tag: string): string {
  return path.join(getResultsDir(repoRoot, tag), 'state.json')
}

export function getProposalJsonPath(repoRoot: string, tag: string): string {
  return path.join(getResultsDir(repoRoot, tag), 'proposal.json')
}

export function getReportsDir(repoRoot: string, tag: string): string {
  return path.join(getAutoresearchRoot(repoRoot), 'reports', tag)
}

export function getLogPath(repoRoot: string, tag: string): string {
  return path.join(getAutoresearchRoot(repoRoot), 'logs', `${tag}.log`)
}

export function getLockPath(repoRoot: string, tag: string): string {
  return path.join(getAutoresearchRoot(repoRoot), 'locks', `${tag}.lock`)
}

export function getDashboardJsonPath(repoRoot: string): string {
  return path.join(getAutoresearchRoot(repoRoot), 'dashboard.json')
}

export function getBranchName(tag: string): string {
  return `autoresearch/${tag}`
}

export function tagForRow(row: MatrixRow): string {
  return `${row.strategy}-${row.exchange}`
}

export function allowedEditPathsForStrategy(strategy: string): string[] {
  return [`config/strategies/${strategy}.yaml`]
}

export function getProposalsDir(repoRoot: string, tag: string): string {
  return path.join(getResultsDir(repoRoot, tag), 'proposals')
}

export function getProposalIterPath(repoRoot: string, tag: string, iter: number): string {
  return path.join(getProposalsDir(repoRoot, tag), `iter_${String(iter)}.json`)
}

const STRATEGY_DOC_FILENAMES: Record<string, string> = {
  strategy_1: '01_strategy_1',
  strategy_1_ws: '02_strategy_1_ws',
  strategy_2: '03_strategy_2',
  strategy_3a: '04_strategy_3a',
  strategy_4_1a: '05_strategy_4_1a',
  strategy_4_2a: '06_strategy_4_2a',
  strategy_6: '07_strategy_6',
}

export function strategyDocFamily(strategyId: string): string {
  return STRATEGY_DOC_FILENAMES[strategyId] ?? strategyId
}
