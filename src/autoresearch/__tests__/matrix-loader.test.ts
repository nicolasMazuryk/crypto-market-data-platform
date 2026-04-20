import { describe, expect, it } from 'vitest'

import { parseMatrixContent, toRunSpec } from '../matrix/loader.js'

const VALID = `
default_iterations: 50
max_parallel: 4
max_parallel_backtests: 2
iteration_timeout_ms: 600000
backtest_timeout_ms: 600000
per_iteration_budget_usd: 0.50
runs:
  - strategy: strategy_1
    exchange: binance
  - strategy: strategy_1
    exchange: okx
    iterations: 100
  - strategy: strategy_5
    exchange_a: binance
    exchange_b: bybit
`.trim()

describe('parseMatrixContent', () => {
  it('accepts a valid matrix and assigns per-row iterations correctly', () => {
    const matrix = parseMatrixContent(VALID)
    expect(matrix.default_iterations).toBe(50)
    expect(matrix.runs).toHaveLength(3)
    const specs = matrix.runs.map(row => toRunSpec(row, matrix))
    expect(specs[0]?.tag).toBe('strategy_1-binance')
    expect(specs[0]?.iterations).toBe(50)
    expect(specs[1]?.tag).toBe('strategy_1-okx')
    expect(specs[1]?.iterations).toBe(100)
    expect(specs[2]?.tag).toBe('strategy_5-binance_bybit')
    expect(specs[2]?.exchange_a).toBe('binance')
    expect(specs[2]?.exchange_b).toBe('bybit')
  })

  it('rejects duplicate tags', () => {
    const dup = VALID.replace(
      '  - strategy: strategy_1\n    exchange: okx\n    iterations: 100',
      '  - strategy: strategy_1\n    exchange: binance'
    )
    expect(() => parseMatrixContent(dup)).toThrow(/duplicate tag/i)
  })

  it('rejects unknown strategy ids', () => {
    const content = VALID.replace('strategy_1', 'strategy_made_up')
    expect(() => parseMatrixContent(content)).toThrow(/not a known strategy id/i)
  })

  it('rejects strategy_5 without exchange_a/exchange_b', () => {
    const content = `
default_iterations: 5
max_parallel: 1
max_parallel_backtests: 1
iteration_timeout_ms: 600000
backtest_timeout_ms: 1000
per_iteration_budget_usd: 0.10
runs:
  - strategy: strategy_5
    exchange: binance
`.trim()
    expect(() => parseMatrixContent(content)).toThrow(/strategy_5 requires 'exchange_a'/i)
  })

  it('rejects non-strategy_5 rows with exchange_a/exchange_b', () => {
    const content = `
default_iterations: 5
max_parallel: 1
max_parallel_backtests: 1
iteration_timeout_ms: 600000
backtest_timeout_ms: 1000
per_iteration_budget_usd: 0.10
runs:
  - strategy: strategy_1
    exchange_a: binance
    exchange_b: bybit
`.trim()
    expect(() => parseMatrixContent(content)).toThrow(/requires 'exchange'/i)
  })

  it('defaults agent to claude when absent', () => {
    const matrix = parseMatrixContent(VALID)
    const specs = matrix.runs.map(row => toRunSpec(row, matrix))
    expect(specs[0]?.agent).toBe('claude')
    expect(specs[1]?.agent).toBe('claude')
  })

  it('accepts agent: codex', () => {
    const content = VALID.replace('  - strategy: strategy_1\n    exchange: binance', '  - strategy: strategy_1\n    exchange: binance\n    agent: codex')
    const matrix = parseMatrixContent(content)
    const row = matrix.runs[0]
    if (row === undefined) throw new Error('expected run')
    const spec = toRunSpec(row, matrix)
    expect(spec.agent).toBe('codex')
  })

  it('rejects unknown agent values', () => {
    const content = VALID.replace('  - strategy: strategy_1\n    exchange: binance', '  - strategy: strategy_1\n    exchange: binance\n    agent: foo')
    expect(() => parseMatrixContent(content)).toThrow(/agent.*must be 'claude' or 'codex'/i)
  })

  it('rejects non-positive iteration overrides', () => {
    const content = `
default_iterations: 5
max_parallel: 1
max_parallel_backtests: 1
iteration_timeout_ms: 600000
backtest_timeout_ms: 1000
per_iteration_budget_usd: 0.10
runs:
  - strategy: strategy_1
    exchange: binance
    iterations: 0
`.trim()
    expect(() => parseMatrixContent(content)).toThrow(/iterations/)
  })
})
