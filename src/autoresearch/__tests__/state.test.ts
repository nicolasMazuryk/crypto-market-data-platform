import { describe, expect, it } from 'vitest'

import { reconstructState } from '../results/state.js'
import type { ResultRow } from '../types.js'

function row(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    iter: 0,
    timestamp: '2026-04-18T00:00:00.000Z',
    commit_hash: 'base',
    total_net_pnl: 0.01,
    sharpe: 0,
    win_rate: 0.5,
    trades: 3,
    status: 'keep',
    description: 'baseline',
    report_path: 'r.json',
    duration_s: 1,
    error_message: '',
    ...overrides,
  }
}

describe('reconstructState', () => {
  it('empty TSV yields zero iter count and no best', () => {
    const state = reconstructState('t', [])
    expect(state.iter_count).toBe(0)
    expect(state.best_pnl).toBeNull()
    expect(state.best_commit).toBeNull()
    expect(state.baseline_commit).toBeNull()
  })

  it('tracks baseline, best, and last-keep across mixed rows', () => {
    const rows: ResultRow[] = [
      row({ iter: 0, status: 'keep', commit_hash: 'base', total_net_pnl: 0.01 }),
      row({ iter: 1, status: 'discard', commit_hash: 'base', total_net_pnl: -0.02 }),
      row({ iter: 2, status: 'keep', commit_hash: 'c2', total_net_pnl: 0.05 }),
      row({ iter: 3, status: 'keep', commit_hash: 'c3', total_net_pnl: 0.03 }),
      row({ iter: 4, status: 'error', commit_hash: 'c3', total_net_pnl: null }),
    ]
    const state = reconstructState('t', rows)
    expect(state.iter_count).toBe(5)
    expect(state.baseline_commit).toBe('base')
    expect(state.best_pnl).toBe(0.05)
    expect(state.best_commit).toBe('c2')
    expect(state.last_keep_commit).toBe('c3')
    expect(state.consecutive_errors).toBe(1)
  })

  it('resets consecutive_errors after a keep/discard', () => {
    const rows: ResultRow[] = [
      row({ iter: 0, status: 'error', total_net_pnl: null }),
      row({ iter: 1, status: 'error', total_net_pnl: null }),
      row({ iter: 2, status: 'keep', commit_hash: 'c2', total_net_pnl: 0.01 }),
      row({ iter: 3, status: 'error', total_net_pnl: null }),
    ]
    const state = reconstructState('t', rows)
    expect(state.consecutive_errors).toBe(1)
  })
})
