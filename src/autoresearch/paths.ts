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
  if (row.strategy === 'strategy_5' && 'exchange_a' in row) {
    return `strategy_5-${row.exchange_a}_${row.exchange_b}`
  }
  if ('exchange' in row) {
    return `${row.strategy}-${row.exchange}`
  }
  throw new Error(`Cannot derive tag for row: ${JSON.stringify(row)}`)
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

export function strategyDocFamily(strategyId: string): string {
  if (strategyId === 'strategy_3a' || strategyId === 'strategy_3b') return 'strategy_3'
  if (strategyId === 'strategy_4_1a' || strategyId === 'strategy_4_1b') return 'strategy_4_1'
  if (strategyId === 'strategy_4_2a' || strategyId === 'strategy_4_2b') return 'strategy_4_2'
  if (strategyId === 'strategy_4_3a' || strategyId === 'strategy_4_3b') return 'strategy_4_3'
  return strategyId
}
