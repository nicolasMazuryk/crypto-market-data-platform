import { z } from 'zod'

import type { StrategyConfig, BacktestOnlyConfig } from '../../backtesting/config/schema.js'
import { CANONICAL_PARAMS, BACKTEST_ONLY_PARAMS, defaultFor } from './params.js'
import { STRATEGY_DEFS, BACKTEST_STRATEGY_IDS, applyCrossFieldBounds } from './strategies.js'
import { zodNumberFor } from './zod-field.js'

const paramsByName = new Map(CANONICAL_PARAMS.map(p => [p.name, p]))

/**
 * Top-level keys belonging to `BaseConfig` (structural fields + §10.2 backtest-only
 * tunables), not to any strategy. `loader.ts` strips these from the merged base+strategy
 * object before validating against the (now-strict) strategy schema, so the strategy
 * schema only ever sees its own scoped fields plus any genuinely-unknown key.
 */
export const BASE_CONFIG_KEYS = new Set<string>([
  'exchange',
  'symbol',
  'start_date',
  'end_date',
  'fees',
  'validation',
  'window',
  'reporting',
  'funding_settlement',
  ...BACKTEST_ONLY_PARAMS.map(p => p.name),
])

function btShapeFor(strategyId: (typeof BACKTEST_STRATEGY_IDS)[number]): Record<string, z.ZodType> {
  const def = STRATEGY_DEFS[strategyId]
  const shape: Record<string, z.ZodType> = { strategy_id: z.literal(strategyId) }

  for (const paramName of def.params) {
    const param = paramsByName.get(paramName)
    if (!param) throw new Error(`Unknown canonical param '${paramName}' referenced by ${strategyId}`)
    if (!param.btKey) continue // live-only param — no backtest representation
    shape[param.btKey] = zodNumberFor(param, defaultFor(param, strategyId), strategyId)
  }

  if (def.btExtra) Object.assign(shape, def.btExtra)
  return shape
}

const backtestObjects = BACKTEST_STRATEGY_IDS.map(id =>
  applyCrossFieldBounds(z.object(btShapeFor(id)).strict(), id, 'bt')
)

/**
 * Generated backtest strategy schema: discriminated union over the 5 backtest strategy
 * ids. The shape is built dynamically from the registry, so TS can't infer per-variant
 * literal keys on its own — cast to the hand-maintained `StrategyConfig` union (still the
 * source of truth for the TS-facing shape; the registry only owns runtime validation).
 */
export const GeneratedBacktestStrategySchema = z.discriminatedUnion(
  'strategy_id',
  backtestObjects as unknown as [(typeof backtestObjects)[number], ...(typeof backtestObjects)[number][]]
) as unknown as z.ZodType<StrategyConfig>

const backtestOnlyBaseShape: Record<string, z.ZodType> = {}
for (const param of BACKTEST_ONLY_PARAMS) {
  backtestOnlyBaseShape[param.name] = zodNumberFor(param, param.default as number)
}

/** Generated schema for the 7 backtest-only BaseConfig fields (§10.2). */
export const GeneratedBacktestOnlyBaseSchema = z.object(
  backtestOnlyBaseShape
) as unknown as z.ZodType<BacktestOnlyConfig>
