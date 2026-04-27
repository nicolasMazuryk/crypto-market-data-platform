import fs from 'fs'
import { parse } from 'yaml'

import { VALID_STRATEGY_IDS } from '../../backtesting/config/schema.js'
import { tagForRow } from '../paths.js'
import type { AgentKind, MatrixFile, MatrixRow, RunSpec } from '../types.js'

interface RawMatrix {
  default_iterations?: unknown
  max_parallel?: unknown
  max_parallel_backtests?: unknown
  iteration_timeout_ms?: unknown
  backtest_timeout_ms?: unknown
  per_iteration_budget_usd?: unknown
  runs?: unknown
}

function assertPositiveInt(val: unknown, field: string): number {
  if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
    throw new Error(`matrix.yaml: '${field}' must be a positive integer, got ${JSON.stringify(val)}`)
  }
  return val
}

function assertPositiveNumber(val: unknown, field: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
    throw new Error(`matrix.yaml: '${field}' must be a positive finite number, got ${JSON.stringify(val)}`)
  }
  return val
}

function normalizeRow(raw: Record<string, unknown>, idx: number): MatrixRow {
  const strategy = raw.strategy
  if (typeof strategy !== 'string' || strategy.length === 0) {
    throw new Error(`matrix.yaml runs[${String(idx)}]: 'strategy' must be a non-empty string`)
  }
  if (!(VALID_STRATEGY_IDS as readonly string[]).includes(strategy)) {
    throw new Error(
      `matrix.yaml runs[${String(idx)}]: strategy '${strategy}' is not a known strategy id ` +
        `(valid: ${VALID_STRATEGY_IDS.join(', ')})`
    )
  }

  const iterationsRaw = raw.iterations
  const iterations =
    iterationsRaw === undefined ? undefined : assertPositiveInt(iterationsRaw, `runs[${String(idx)}].iterations`)

  const agentRaw = raw.agent
  let agent: AgentKind = 'claude'
  if (agentRaw !== undefined) {
    if (agentRaw !== 'claude' && agentRaw !== 'codex') {
      throw new Error(
        `matrix.yaml runs[${String(idx)}]: 'agent' must be 'claude' or 'codex', got ${JSON.stringify(agentRaw)}`
      )
    }
    agent = agentRaw
  }

  if (strategy === 'strategy_5') {
    const exchange_a = raw.exchange_a
    const exchange_b = raw.exchange_b
    if (typeof exchange_a !== 'string' || exchange_a.length === 0) {
      throw new Error(`matrix.yaml runs[${String(idx)}]: strategy_5 requires 'exchange_a'`)
    }
    if (typeof exchange_b !== 'string' || exchange_b.length === 0) {
      throw new Error(`matrix.yaml runs[${String(idx)}]: strategy_5 requires 'exchange_b'`)
    }
    if ('exchange' in raw) {
      throw new Error(`matrix.yaml runs[${String(idx)}]: strategy_5 must not set 'exchange'`)
    }
    return {
      strategy: 'strategy_5',
      exchange_a,
      exchange_b,
      agent,
      ...(iterations === undefined ? {} : { iterations }),
    }
  }

  const exchange = raw.exchange
  if (typeof exchange !== 'string' || exchange.length === 0) {
    throw new Error(`matrix.yaml runs[${String(idx)}]: '${strategy}' requires 'exchange'`)
  }
  if ('exchange_a' in raw || 'exchange_b' in raw) {
    throw new Error(`matrix.yaml runs[${String(idx)}]: only strategy_5 uses 'exchange_a'/'exchange_b'`)
  }
  return {
    strategy,
    exchange,
    agent,
    ...(iterations === undefined ? {} : { iterations }),
  }
}

export function parseMatrixContent(content: string): MatrixFile {
  const parsed: unknown = parse(content)
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('matrix.yaml must be a YAML mapping')
  }
  const raw = parsed as RawMatrix

  const default_iterations = assertPositiveInt(raw.default_iterations, 'default_iterations')
  const max_parallel = assertPositiveInt(raw.max_parallel, 'max_parallel')
  const max_parallel_backtests = assertPositiveInt(raw.max_parallel_backtests, 'max_parallel_backtests')
  const iteration_timeout_ms = assertPositiveInt(raw.iteration_timeout_ms, 'iteration_timeout_ms')
  const backtest_timeout_ms = assertPositiveInt(raw.backtest_timeout_ms, 'backtest_timeout_ms')
  const per_iteration_budget_usd = assertPositiveNumber(raw.per_iteration_budget_usd, 'per_iteration_budget_usd')

  if (!Array.isArray(raw.runs) || raw.runs.length === 0) {
    throw new Error(`matrix.yaml: 'runs' must be a non-empty array`)
  }
  const rawRuns: unknown[] = raw.runs

  const runs: MatrixRow[] = []
  const seenTags = new Set<string>()
  for (let i = 0; i < rawRuns.length; i++) {
    const item = rawRuns[i]
    if (item === null || item === undefined || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`matrix.yaml runs[${String(i)}] must be a mapping`)
    }
    const row = normalizeRow(item as Record<string, unknown>, i)
    const tag = tagForRow(row)
    if (seenTags.has(tag)) {
      throw new Error(`matrix.yaml: duplicate tag '${tag}' at runs[${String(i)}]`)
    }
    seenTags.add(tag)
    runs.push(row)
  }

  return {
    default_iterations,
    max_parallel,
    max_parallel_backtests,
    iteration_timeout_ms,
    backtest_timeout_ms,
    per_iteration_budget_usd,
    runs,
  }
}

export function loadMatrix(matrixPath: string): MatrixFile {
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`Matrix file not found: ${matrixPath}`)
  }
  const content = fs.readFileSync(matrixPath, 'utf-8')
  return parseMatrixContent(content)
}

export function toRunSpec(row: MatrixRow, matrix: MatrixFile): RunSpec {
  const iterations = row.iterations ?? matrix.default_iterations
  if (row.strategy === 'strategy_5' && 'exchange_a' in row) {
    return {
      tag: tagForRow(row),
      strategy: row.strategy,
      exchange: null,
      exchange_a: row.exchange_a,
      exchange_b: row.exchange_b,
      iterations,
      iteration_timeout_ms: matrix.iteration_timeout_ms,
      backtest_timeout_ms: matrix.backtest_timeout_ms,
      per_iteration_budget_usd: matrix.per_iteration_budget_usd,
      agent: row.agent,
    }
  }
  if ('exchange' in row) {
    return {
      tag: tagForRow(row),
      strategy: row.strategy,
      exchange: row.exchange,
      exchange_a: null,
      exchange_b: null,
      iterations,
      iteration_timeout_ms: matrix.iteration_timeout_ms,
      backtest_timeout_ms: matrix.backtest_timeout_ms,
      per_iteration_budget_usd: matrix.per_iteration_budget_usd,
      agent: row.agent,
    }
  }
  throw new Error(`Cannot build RunSpec for row: ${JSON.stringify(row)}`)
}
