import fs from 'fs'
import path from 'path'
import { parse as parseYaml } from 'yaml'

import { allowedEditPathsForStrategy } from '../paths.js'
import type { RunSpec } from '../types.js'

import { checkoutPaths, cleanPaths, diffNameOnlyHead, listUntracked } from './ratchet.js'

export interface DiffGateResult {
  outOfScopePaths: string[]
  revertedPaths: string[]
  cleanedPaths: string[]
  /** True if strategy_5 and the agent mutated main_exchange or exclude_exchanges. */
  pinnedExchangesMutated: boolean
  errorMessage: string | null
}

/**
 * Enforce that the agent only touched allowed files. Any out-of-scope change
 * (modified or untracked) is reverted. For strategy_5, additionally assert
 * main_exchange/exclude_exchanges were not changed — if they were, revert the YAML to
 * HEAD entirely and report the violation.
 */
export async function enforceScope(worktreePath: string, spec: RunSpec): Promise<DiffGateResult> {
  const allowed = new Set(allowedEditPathsForStrategy(spec.strategy))
  const changed = await diffNameOnlyHead(worktreePath)
  const untracked = await listUntracked(worktreePath)

  const outOfScopeChanged = changed.filter(p => !allowed.has(p))
  const outOfScopeUntracked = untracked.filter(p => !allowed.has(p))

  const revertedPaths: string[] = []
  if (outOfScopeChanged.length > 0) {
    await checkoutPaths(worktreePath, 'HEAD', outOfScopeChanged)
    revertedPaths.push(...outOfScopeChanged)
  }
  const cleanedPaths: string[] = []
  if (outOfScopeUntracked.length > 0) {
    await cleanPaths(worktreePath, outOfScopeUntracked)
    cleanedPaths.push(...outOfScopeUntracked)
  }

  let pinnedExchangesMutated = false
  if (spec.strategy === 'strategy_5') {
    pinnedExchangesMutated = checkStrategy5Pins(worktreePath, spec)
    if (pinnedExchangesMutated) {
      // Revert the strategy YAML to HEAD entirely so the agent's attempt to
      // change pins also reverts their other edits (all-or-nothing for this
      // iteration).
      const yaml = `config/strategies/${spec.strategy}.yaml`
      await checkoutPaths(worktreePath, 'HEAD', [yaml])
      revertedPaths.push(yaml)
    }
  }

  const outOfScopePaths = [...outOfScopeChanged, ...outOfScopeUntracked]
  let errorMessage: string | null = null
  if (pinnedExchangesMutated) {
    errorMessage = `strategy_5 pinned_exchanges_mutated; reverted ${spec.strategy}.yaml`
  } else if (outOfScopePaths.length > 0) {
    errorMessage = `out_of_scope_edit: ${outOfScopePaths.join(', ')}`
  }
  return {
    outOfScopePaths,
    revertedPaths,
    cleanedPaths,
    pinnedExchangesMutated,
    errorMessage,
  }
}

function checkStrategy5Pins(worktreePath: string, spec: RunSpec): boolean {
  if (spec.main_exchange === null) return false
  const yamlPath = path.join(worktreePath, 'config', 'strategies', `${spec.strategy}.yaml`)
  if (!fs.existsSync(yamlPath)) return false
  const content = fs.readFileSync(yamlPath, 'utf-8')
  const parsed = parseYaml(content) as Record<string, unknown> | null
  if (parsed === null) return false
  if (parsed.main_exchange !== spec.main_exchange) return true
  if (spec.exclude_exchanges !== null) {
    const yamlExcludes: string[] = Array.isArray(parsed.exclude_exchanges)
      ? (parsed.exclude_exchanges as string[])
      : []
    const specExcludes = spec.exclude_exchanges
    if (JSON.stringify([...yamlExcludes].sort()) !== JSON.stringify([...specExcludes].sort())) return true
  }
  return false
}
