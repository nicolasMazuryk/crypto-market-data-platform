import fs from 'fs'
import path from 'path'
import { parse } from 'yaml'
import { z } from 'zod'

import type { BaseConfig, ResolvedConfig, StrategyConfig, FeeSchedule, FundingSettlementConfig } from './schema.js'
import {
  GeneratedBacktestStrategySchema,
  GeneratedBacktestOnlyBaseSchema,
} from '../../config/canonical/generate-backtest.js'

/** Deep-merge source into target. Source values take precedence. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = target[key]
    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      targetVal !== undefined &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>)
    } else {
      result[key] = sourceVal
    }
  }
  return result
}

function loadYaml(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, 'utf-8')
  const parsed: unknown = parse(content)
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${filePath} must contain a YAML mapping, got ${typeof parsed}`)
  }
  return parsed as Record<string, unknown>
}

function requireString(obj: Record<string, unknown>, field: string, context: string): string {
  const val = obj[field]
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`${context}: '${field}' must be a non-empty string, got ${JSON.stringify(val)}`)
  }
  return val
}

function requireNumber(obj: Record<string, unknown>, field: string, context: string): number {
  const val = obj[field]
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`${context}: '${field}' must be a finite number, got ${JSON.stringify(val)}`)
  }
  return val
}

function requirePositiveNumber(obj: Record<string, unknown>, field: string, context: string): number {
  const val = requireNumber(obj, field, context)
  if (val <= 0) {
    throw new Error(`${context}: '${field}' must be positive, got ${String(val)}`)
  }
  return val
}

function requireNonNegativeNumber(obj: Record<string, unknown>, field: string, context: string): number {
  const val = requireNumber(obj, field, context)
  if (val < 0) {
    throw new Error(`${context}: '${field}' must be non-negative, got ${String(val)}`)
  }
  return val
}

function requirePositiveInt(obj: Record<string, unknown>, field: string, context: string): number {
  const val = requireNumber(obj, field, context)
  if (!Number.isInteger(val) || val <= 0) {
    throw new Error(`${context}: '${field}' must be a positive integer, got ${String(val)}`)
  }
  return val
}

function requireIntInRange(
  obj: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  context: string
): number {
  const val = requireNumber(obj, field, context)
  if (!Number.isInteger(val) || val < min || val > max) {
    const rangeDesc = max === Number.MAX_SAFE_INTEGER ? `>= ${String(min)}` : `${String(min)}..${String(max)}`
    throw new Error(`${context}: '${field}' must be an integer ${rangeDesc}, got ${String(val)}`)
  }
  return val
}

function requireBoolean(obj: Record<string, unknown>, field: string, context: string): boolean {
  const val = obj[field]
  if (typeof val !== 'boolean') {
    throw new Error(`${context}: '${field}' must be a boolean, got ${JSON.stringify(val)}`)
  }
  return val
}

function validateFeeSchedule(obj: unknown, exchange: string): FeeSchedule {
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`Fee schedule for '${exchange}' must be an object`)
  }
  const feeObj = obj as Record<string, unknown>
  return {
    taker_fee: requireNonNegativeNumber(feeObj, 'taker_fee', `fees.${exchange}`),
    maker_fee: requireNonNegativeNumber(feeObj, 'maker_fee', `fees.${exchange}`),
  }
}

function validateBaseConfig(merged: Record<string, unknown>): BaseConfig {
  const ctx = 'base_config'

  const exchange = requireString(merged, 'exchange', ctx)
  const symbolVal = merged.symbol
  const symbol = typeof symbolVal === 'string' && symbolVal.length > 0 ? symbolVal : undefined
  const start_date = requireString(merged, 'start_date', ctx)
  const end_date = requireString(merged, 'end_date', ctx)

  // Fees
  const feesRaw = merged.fees
  if (feesRaw === null || feesRaw === undefined || typeof feesRaw !== 'object' || Array.isArray(feesRaw)) {
    throw new Error(`${ctx}: 'fees' must be an object`)
  }
  const feesObj = feesRaw as Record<string, unknown>
  const fees: Record<string, FeeSchedule> = {}
  for (const [exch, schedule] of Object.entries(feesObj)) {
    fees[exch] = validateFeeSchedule(schedule, exch)
  }

  // Validation
  const validationRaw = merged.validation
  if (
    validationRaw === null ||
    validationRaw === undefined ||
    typeof validationRaw !== 'object' ||
    Array.isArray(validationRaw)
  ) {
    throw new Error(`${ctx}: 'validation' must be an object`)
  }
  const vObj = validationRaw as Record<string, unknown>
  const validation = {
    required_seconds_before: requirePositiveInt(vObj, 'required_seconds_before', `${ctx}.validation`),
    required_seconds_after: requirePositiveInt(vObj, 'required_seconds_after', `${ctx}.validation`),
    max_gap_seconds: requirePositiveInt(vObj, 'max_gap_seconds', `${ctx}.validation`),
    max_price_change_pct: requirePositiveNumber(vObj, 'max_price_change_pct', `${ctx}.validation`),
  }

  // Window
  const windowRaw = merged.window
  if (windowRaw === null || windowRaw === undefined || typeof windowRaw !== 'object' || Array.isArray(windowRaw)) {
    throw new Error(`${ctx}: 'window' must be an object`)
  }
  const wObj = windowRaw as Record<string, unknown>
  const window = {
    pre_funding_seconds: requirePositiveInt(wObj, 'pre_funding_seconds', `${ctx}.window`),
    post_funding_seconds: requirePositiveInt(wObj, 'post_funding_seconds', `${ctx}.window`),
  }

  // Backtest-only simulation params (§10.2) — generated from the canonical registry
  let backtestOnly: z.infer<typeof GeneratedBacktestOnlyBaseSchema>
  try {
    backtestOnly = GeneratedBacktestOnlyBaseSchema.parse(merged)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const first = err.issues[0]
      throw new Error(`${ctx}: ${first ? `'${first.path.join('.')}' ${first.message}` : err.message}`)
    }
    throw err
  }

  // Reporting
  const reportingRaw = merged.reporting
  if (
    reportingRaw === null ||
    reportingRaw === undefined ||
    typeof reportingRaw !== 'object' ||
    Array.isArray(reportingRaw)
  ) {
    throw new Error(`${ctx}: 'reporting' must be an object`)
  }
  const rObj = reportingRaw as Record<string, unknown>
  const reporting = {
    include_trade_log: requireBoolean(rObj, 'include_trade_log', `${ctx}.reporting`),
    output_dir: requireString(rObj, 'output_dir', `${ctx}.reporting`),
  }

  // funding_settlement — optional with defaults
  const fsRaw = merged.funding_settlement
  let funding_settlement: FundingSettlementConfig
  if (fsRaw === null || fsRaw === undefined) {
    funding_settlement = { detection_window_seconds: 10, tp_post_settlement_buffer_seconds: 1 }
  } else {
    if (typeof fsRaw !== 'object' || Array.isArray(fsRaw)) {
      throw new Error(`${ctx}: 'funding_settlement' must be an object`)
    }
    const fsObj = fsRaw as Record<string, unknown>
    const dws = requireIntInRange(fsObj, 'detection_window_seconds', 1, 60, `${ctx}.funding_settlement`)
    const tpBuf = requireNonNegativeNumber(fsObj, 'tp_post_settlement_buffer_seconds', `${ctx}.funding_settlement`)
    funding_settlement = { detection_window_seconds: dws, tp_post_settlement_buffer_seconds: tpBuf }
  }

  return {
    exchange,
    ...(symbol ? { symbol } : {}),
    start_date,
    end_date,
    fees,
    validation,
    window,
    reporting,
    funding_settlement,
    ...backtestOnly,
  }
}

/**
 * Validate the strategy portion of a merged config against the canonical-registry-
 * generated backtest schema (see src/config/canonical/). Per-field hard bounds
 * (entry_offset_seconds ranges, ladder_count minimums, etc.) are intentionally NOT
 * enforced here — Task 06 layers those on top of the generated shapes using the
 * `bounds` data on CANONICAL_PARAMS. Until Task 06 lands, only shape/type is validated.
 */
function validateStrategyConfig(merged: Record<string, unknown>): StrategyConfig {
  const result = GeneratedBacktestStrategySchema.safeParse(merged)
  if (!result.success) {
    const first = result.error.issues[0]
    const strategyId = typeof merged.strategy_id === 'string' ? merged.strategy_id : 'unknown'
    const path = first ? first.path.join('.') : 'strategy_id'
    const message = first ? first.message : result.error.message
    throw new Error(`strategy[${strategyId}]: '${path}' ${message}`)
  }
  return result.data
}

/**
 * Load and validate a backtest configuration.
 *
 * @param strategyConfigPath - Path to the strategy YAML file
 * @param baseConfigPath - Optional path to base YAML (defaults to config/base_config.yaml)
 * @returns Frozen ResolvedConfig
 */
export function loadConfig(strategyConfigPath: string, baseConfigPath?: string): ResolvedConfig {
  const resolvedBase = baseConfigPath ?? path.join(process.cwd(), 'config', 'base_config.yaml')

  if (!fs.existsSync(resolvedBase)) {
    throw new Error(`Base config not found: ${resolvedBase}`)
  }
  if (!fs.existsSync(strategyConfigPath)) {
    throw new Error(`Strategy config not found: ${strategyConfigPath}`)
  }

  const baseRaw = loadYaml(resolvedBase)
  const strategyRaw = loadYaml(strategyConfigPath)
  const merged = deepMerge(baseRaw, strategyRaw)

  const base = validateBaseConfig(merged)
  const strategy = validateStrategyConfig(merged)

  const resolved: ResolvedConfig = { base, strategy }
  return Object.freeze(resolved)
}
