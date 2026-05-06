import crypto from 'crypto'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { getBranchName, getReportsDir, getWorktreePath } from '../paths.js'
import type { RunSpec } from '../types.js'

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function execGit(repoRoot: string, args: string[]): Promise<ExecResult> {
  return new Promise(resolve => {
    const proc = spawn('git', args, { cwd: repoRoot })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    proc.on('close', (code: number | null) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function runGit(repoRoot: string, args: string[], context: string): Promise<string> {
  const result = await execGit(repoRoot, args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${context}): ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

function ensureSymlink(target: string, linkPath: string): void {
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    return
  }
  if (!fs.existsSync(target)) {
    return
  }
  fs.symlinkSync(target, linkPath)
}

interface WorktreeInfo {
  path: string
  branch: string | null
}

function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const infos: WorktreeInfo[] = []
  let current: { path?: string; branch?: string } = {}
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path !== undefined) infos.push({ path: current.path, branch: current.branch ?? null })
      current = { path: line.slice('worktree '.length).trim() }
    } else if (line.startsWith('branch ') && current.path !== undefined) {
      current.branch = line.slice('branch '.length).trim()
    }
  }
  if (current.path !== undefined) infos.push({ path: current.path, branch: current.branch ?? null })
  return infos
}

/** List worktrees attached to this repo. Each entry is an absolute path. */
export async function listWorktreePaths(repoRoot: string): Promise<string[]> {
  const out = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], 'list')
  return parseWorktreePorcelain(out).map(w => w.path)
}

function uniqueBranchName(repoRoot: string, tag: string): string {
  const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
  return `autoresearch-${hash}-${tag}`
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return result.code === 0
}

export interface CreateWorktreeOptions {
  repoRoot: string
  spec: RunSpec
  /** When true, the worktree will be recreated from current main even if it already exists. */
  reset?: boolean
}

export interface WorktreeHandle {
  worktreePath: string
  branch: string
  baselineCommit: string
}

/**
 * Create (or re-use) a worktree for the given run. Sets exchange override in
 * base_config.yaml for non-cross-exchange strategies, points reporting output
 * into the per-tag reports dir, and symlinks node_modules / package.json /
 * tsconfig.json / .env so that `tsx` resolves identically to the main repo.
 */
export async function ensureWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const { repoRoot, spec, reset } = opts
  const worktreePath = getWorktreePath(repoRoot, spec.tag)
  const preferredBranch = getBranchName(spec.tag)

  if (reset && fs.existsSync(worktreePath)) {
    await removeWorktree(repoRoot, spec.tag)
    // Delete the workspace-unique branch so the new worktree starts from current HEAD.
    const uniqueBranch = uniqueBranchName(repoRoot, spec.tag)
    if (await branchExists(repoRoot, uniqueBranch)) {
      await runGit(repoRoot, ['branch', '-D', uniqueBranch], 'delete unique branch for reset')
    }
  }

  const porcelain = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], 'list')
  const worktreeInfos = parseWorktreePorcelain(porcelain)
  const alreadyAttached = worktreeInfos.some(w => w.path === worktreePath)
  const preferredBranchLocked = worktreeInfos.some(
    w => w.path !== worktreePath && w.branch === `refs/heads/${preferredBranch}`
  )

  let branch = preferredBranch

  if (!alreadyAttached) {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
    const exists = await branchExists(repoRoot, preferredBranch)
    if (exists && !preferredBranchLocked) {
      await runGit(repoRoot, ['worktree', 'add', worktreePath, preferredBranch], 'attach existing branch')
    } else if (exists && preferredBranchLocked) {
      // Preferred branch is checked out in another worktree (e.g. a different workspace).
      // Create a workspace-unique branch from HEAD instead.
      branch = uniqueBranchName(repoRoot, spec.tag)
      const uniqueExists = await branchExists(repoRoot, branch)
      if (uniqueExists) {
        await runGit(repoRoot, ['worktree', 'add', worktreePath, branch], 'attach unique branch')
      } else {
        await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], 'create unique branch')
      }
    } else {
      await runGit(repoRoot, ['worktree', 'add', '-b', preferredBranch, worktreePath, 'HEAD'], 'create new branch')
    }
  } else {
    // Worktree already exists — find the actual branch it's on.
    const info = worktreeInfos.find(w => w.path === worktreePath)
    if (info?.branch !== null && info?.branch !== undefined) {
      branch = info.branch.replace('refs/heads/', '')
    }
  }

  // Symlink hoisted files.
  const linkTargets: [string, string][] = [
    [path.join(repoRoot, 'node_modules'), path.join(worktreePath, 'node_modules')],
    [path.join(repoRoot, '.env'), path.join(worktreePath, '.env')],
  ]
  for (const [target, link] of linkTargets) {
    ensureSymlink(target, link)
  }

  // Override base_config.yaml (worktree only — never commit this to main).
  applyBaseConfigOverrides(worktreePath, spec)

  // Ensure reports dir exists.
  fs.mkdirSync(getReportsDir(repoRoot, spec.tag), { recursive: true })

  // Stage the overrides as the worktree baseline commit if they produced a
  // dirty tree. This way iter 0 runs against a known-clean commit.
  const status = await runGit(worktreePath, ['status', '--porcelain'], 'status')
  if (status.trim().length > 0) {
    await runGit(worktreePath, ['add', '-A'], 'stage baseline')
    await runGit(worktreePath, ['commit', '-m', `autoresearch ${spec.tag}: baseline setup`], 'commit baseline')
  }

  const head = (await runGit(worktreePath, ['rev-parse', 'HEAD'], 'baseline rev-parse')).trim()
  return { worktreePath, branch, baselineCommit: head }
}

export async function removeWorktree(repoRoot: string, tag: string): Promise<void> {
  const worktreePath = getWorktreePath(repoRoot, tag)
  if (!fs.existsSync(worktreePath)) return
  await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath], 'remove worktree')
}

/**
 * Delete the autoresearch branch for a tag if no remaining worktree is using it.
 * Safe to call after removeWorktree; skips silently if the branch does not exist
 * or is still in use by another worktree.
 */
export async function deleteAutoresearchBranch(repoRoot: string, tag: string): Promise<void> {
  const branch = getBranchName(tag)
  if (!(await branchExists(repoRoot, branch))) return

  // Verify no other worktree is still using this branch before deleting.
  const porcelain = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], 'list worktrees')
  const inUse = parseWorktreePorcelain(porcelain).some(w => w.branch === `refs/heads/${branch}`)
  if (inUse) return

  const result = await execGit(repoRoot, ['branch', '-D', branch])
  if (result.code !== 0) {
    console.warn(`[autoresearch] Could not delete branch ${branch}: ${result.stderr.trim()}`)
  }
}

function applyBaseConfigOverrides(worktreePath: string, spec: RunSpec): void {
  const baseConfigPath = path.join(worktreePath, 'config', 'base_config.yaml')
  if (!fs.existsSync(baseConfigPath)) {
    throw new Error(`Expected ${baseConfigPath} to exist in worktree`)
  }
  const raw = fs.readFileSync(baseConfigPath, 'utf-8')
  const parsed = parseYaml(raw) as Record<string, unknown> | null
  if (parsed === null) {
    throw new Error(`Could not parse ${baseConfigPath}`)
  }

  // Set exchange override for non-cross-exchange strategies.
  if (spec.exchange !== null) {
    parsed.exchange = spec.exchange
  }

  // Override reporting output dir to a relative path inside the autoresearch
  // reports tree. The runner will pass absolute cwd so formatReport writes here.
  const reportingRaw = parsed.reporting
  const reporting =
    reportingRaw !== null && reportingRaw !== undefined && typeof reportingRaw === 'object'
      ? (reportingRaw as Record<string, unknown>)
      : {}
  // worktree lives at <repoRoot>/.autoresearch/worktrees/<tag>; reports at
  // <repoRoot>/.autoresearch/reports/<tag>
  reporting.output_dir = path.posix.join('..', '..', 'reports', spec.tag)
  parsed.reporting = reporting

  fs.writeFileSync(baseConfigPath, stringifyYaml(parsed))

  // strategy_spot_futures uses perp_exchange/spot_exchange (not base.exchange)
  // for data queries — patch the strategy YAML directly so all runs target the right exchange.
  if (spec.exchange !== null && spec.strategy === 'strategy_spot_futures') {
    const sfConfigPath = path.join(worktreePath, 'config', 'strategies', 'strategy_spot_futures.yaml')
    if (fs.existsSync(sfConfigPath)) {
      const sfRaw = fs.readFileSync(sfConfigPath, 'utf-8')
      const sfParsed = parseYaml(sfRaw) as Record<string, unknown> | null
      if (sfParsed !== null) {
        sfParsed.exchange = spec.exchange
        sfParsed.perp_exchange = spec.exchange
        sfParsed.spot_exchange = spec.exchange
        fs.writeFileSync(sfConfigPath, stringifyYaml(sfParsed))
      }
    }
  }
}
