import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { enforceScope } from '../git/diff-gate.js'
import type { RunSpec } from '../types.js'

function runGit(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  }
}

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-gate-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test'])
  runGit(dir, ['config', 'commit.gpgsign', 'false'])
  fs.mkdirSync(path.join(dir, 'config', 'strategies'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'config', 'strategies', 'strategy_1.yaml'),
    'strategy_id: strategy_1\ndirection: long\nfunding_threshold: 0.004\nentry_offset_seconds: 5\nexit_offset_seconds: 2\n'
  )
  fs.writeFileSync(
    path.join(dir, 'config', 'strategies', 'strategy_5.yaml'),
    'strategy_id: strategy_5\nmain_exchange: binance\nexclude_exchanges: []\nmain_exchange_funding_threshold: 0.005\nmin_funding_spread: 0.004\nstop_loss: 0.005\ntp_multiplier: 1.5\nentry_offset_seconds: 3\ndeadline_seconds: 60\nfunding_applied_on_same_second: true\n'
  )
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'original\n')
  runGit(dir, ['add', '-A'])
  runGit(dir, ['commit', '-m', 'init'])
  return dir
}

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    tag: 'strategy_1-binance',
    strategy: 'strategy_1',
    exchange: 'binance',
    main_exchange: null,
    exclude_exchanges: null,
    iterations: 10,
    iteration_timeout_ms: 600_000,
    backtest_timeout_ms: 1000,
    per_iteration_budget_usd: 0.1,
    agent: 'claude',
    ...overrides,
  }
}

describe('enforceScope (diff-gate)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('accepts edits inside the allowed set', async () => {
    const p = path.join(repo, 'config', 'strategies', 'strategy_1.yaml')
    fs.writeFileSync(p, fs.readFileSync(p, 'utf-8') + '# tweak\n')
    const result = await enforceScope(repo, baseSpec())
    expect(result.errorMessage).toBeNull()
    expect(result.outOfScopePaths).toEqual([])
  })

  it('reverts out-of-scope modified files', async () => {
    const yaml = path.join(repo, 'config', 'strategies', 'strategy_1.yaml')
    fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf-8') + '# tweak\n')
    const bad = path.join(repo, 'unrelated.txt')
    fs.writeFileSync(bad, 'MUTATED\n')
    const result = await enforceScope(repo, baseSpec())
    expect(result.errorMessage).toMatch(/out_of_scope_edit/)
    expect(fs.readFileSync(bad, 'utf-8')).toBe('original\n')
  })

  it('cleans untracked out-of-scope files', async () => {
    const newFile = path.join(repo, 'src', 'evil.ts')
    fs.mkdirSync(path.dirname(newFile), { recursive: true })
    fs.writeFileSync(newFile, 'console.log("bad")')
    const result = await enforceScope(repo, baseSpec())
    expect(result.errorMessage).toMatch(/out_of_scope_edit/)
    expect(fs.existsSync(newFile)).toBe(false)
  })

  it('detects strategy_5 pinned main_exchange mutation and reverts the yaml', async () => {
    const p = path.join(repo, 'config', 'strategies', 'strategy_5.yaml')
    const before = fs.readFileSync(p, 'utf-8')
    const mutated = before.replace('main_exchange: binance', 'main_exchange: okx')
    fs.writeFileSync(p, mutated)
    const result = await enforceScope(
      repo,
      baseSpec({
        tag: 'strategy_5-binance',
        strategy: 'strategy_5',
        exchange: null,
        main_exchange: 'binance',
        exclude_exchanges: [],
      })
    )
    expect(result.pinnedExchangesMutated).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe(before)
  })
})
