import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildPrompt } from '../agent/prompt-builder.js'
import type { ResultRow, RunSpec } from '../types.js'

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    tag: 'strategy_1-binance',
    strategy: 'strategy_1',
    exchange: 'binance',
    iterations: 50,
    iteration_timeout_ms: 600_000,
    backtest_timeout_ms: 600_000,
    per_iteration_budget_usd: 0.5,
    agent: 'claude',
    ...overrides,
  }
}

describe('buildPrompt', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-prompt-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('produces stable prefix across iterations (for prompt caching)', () => {
    const program = path.join(dir, 'program.md')
    const yamlPath = path.join(dir, 'strat.yaml')
    const proposal = path.join(dir, 'proposal.json')
    fs.writeFileSync(program, '# program\ndo the thing')
    fs.writeFileSync(yamlPath, 'strategy_id: strategy_1\nfunding_threshold: 0.004')

    const makeArgs = (iter: number, rows: ResultRow[]): Parameters<typeof buildPrompt>[0] => ({
      repoRoot: dir,
      worktreePath: dir,
      spec: spec(),
      programMdPath: program,
      strategyYamlPath: yamlPath,
      iter,
      iterations: 50,
      bestPnl: null,
      baselinePnl: null,
      recentRows: rows,
      proposalPath: proposal,
    })

    const p1 = buildPrompt(makeArgs(1, []))
    const p2 = buildPrompt(makeArgs(2, []))

    // Split on the iteration-context marker: prefix must be identical.
    const marker = '## Iteration context'
    const prefix1 = p1.slice(0, p1.indexOf(marker))
    const prefix2 = p2.slice(0, p2.indexOf(marker))
    expect(prefix1).toBe(prefix2)
    expect(prefix1.length).toBeGreaterThan(100)
  })
})
