import { spawn } from 'child_process'

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function exec(cwd: string, args: string[]): Promise<ExecResult> {
  return new Promise(resolve => {
    const proc = spawn('git', args, { cwd })
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

async function run(cwd: string, args: string[], context: string): Promise<string> {
  const result = await exec(cwd, args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${context}): ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

export async function revParseHead(worktreePath: string): Promise<string> {
  const out = await run(worktreePath, ['rev-parse', 'HEAD'], 'rev-parse')
  return out.trim()
}

export async function commitAll(worktreePath: string, message: string): Promise<string> {
  // Stage all worktree changes (our allowed scope is enforced by diff-gate
  // before this is ever called).
  await run(worktreePath, ['add', '-A'], 'commit-all: add')
  await run(worktreePath, ['commit', '-m', message, '--allow-empty-message'], 'commit-all: commit')
  return revParseHead(worktreePath)
}

export async function resetHard(worktreePath: string, target: string): Promise<void> {
  await run(worktreePath, ['reset', '--hard', target], `reset --hard ${target}`)
}

export async function checkoutPaths(worktreePath: string, target: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await run(worktreePath, ['checkout', target, '--', ...paths], 'checkout paths')
}

export async function cleanPaths(worktreePath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await run(worktreePath, ['clean', '-fd', '--', ...paths], 'clean paths')
}

export async function diffNameOnlyHead(worktreePath: string): Promise<string[]> {
  const out = await run(worktreePath, ['diff', '--name-only', 'HEAD'], 'diff --name-only HEAD')
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

export async function listUntracked(worktreePath: string): Promise<string[]> {
  const out = await run(
    worktreePath,
    ['ls-files', '--others', '--exclude-standard'],
    'ls-files --others'
  )
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

export async function commitExists(worktreePath: string, sha: string): Promise<boolean> {
  const result = await exec(worktreePath, ['cat-file', '-e', `${sha}^{commit}`])
  return result.code === 0
}

export async function isAncestor(worktreePath: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await exec(worktreePath, ['merge-base', '--is-ancestor', ancestor, descendant])
  return result.code === 0
}
