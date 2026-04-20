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

/** List worktrees attached to this repo. Each entry is an absolute path. */
export async function listWorktreePaths(repoRoot: string): Promise<string[]> {
  const out = await runGit(repoRoot, ['worktree', 'list', '--porcelain'], 'list')
  const paths: string[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length).trim())
    }
  }
  return paths
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
  const branch = getBranchName(spec.tag)

  if (reset && fs.existsSync(worktreePath)) {
    await removeWorktree(repoRoot, spec.tag)
  }

  const worktrees = await listWorktreePaths(repoRoot)
  const alreadyAttached = worktrees.includes(worktreePath)

  if (!alreadyAttached) {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
    const exists = await branchExists(repoRoot, branch)
    if (exists) {
      await runGit(repoRoot, ['worktree', 'add', worktreePath, branch], 'attach existing branch')
    } else {
      await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], 'create new branch')
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
    await runGit(
      worktreePath,
      ['commit', '-m', `autoresearch ${spec.tag}: baseline setup`],
      'commit baseline'
    )
  }

  const head = (await runGit(worktreePath, ['rev-parse', 'HEAD'], 'baseline rev-parse')).trim()
  return { worktreePath, branch, baselineCommit: head }
}

export async function removeWorktree(repoRoot: string, tag: string): Promise<void> {
  const worktreePath = getWorktreePath(repoRoot, tag)
  if (!fs.existsSync(worktreePath)) return
  await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath], 'remove worktree')
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
}
