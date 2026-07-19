import { allowedEditPathsForStrategy } from '../paths.js'
import type { RunSpec } from '../types.js'

import { checkoutPaths, cleanPaths, diffNameOnlyHead, listUntracked } from './ratchet.js'

export interface DiffGateResult {
  outOfScopePaths: string[]
  revertedPaths: string[]
  cleanedPaths: string[]
  errorMessage: string | null
}

/**
 * Enforce that the agent only touched allowed files. Any out-of-scope change
 * (modified or untracked) is reverted.
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

  const outOfScopePaths = [...outOfScopeChanged, ...outOfScopeUntracked]
  let errorMessage: string | null = null
  if (outOfScopePaths.length > 0) {
    errorMessage = `out_of_scope_edit: ${outOfScopePaths.join(', ')}`
  }
  return {
    outOfScopePaths,
    revertedPaths,
    cleanedPaths,
    errorMessage,
  }
}
