import { z } from 'zod'

import type {
  Strategy1Config,
  Strategy1WsConfig,
  Strategy2Config,
  Strategy3aConfig,
  Strategy4_1aConfig,
  Strategy4_2aConfig,
  Strategy6Config,
} from '../../execution/strategies/types.js'
import { CANONICAL_PARAMS, defaultFor } from './params.js'
import { STRATEGY_DEFS, ALL_STRATEGY_IDS, applyCrossFieldBounds } from './strategies.js'
import { zodNumberFor } from './zod-field.js'

/**
 * Raw (pre-transform) live strategy shape: identical to the maintained per-strategy
 * config types except strategy_3a's `tpVariant`, which parseEngineConfig synthesizes
 * after parsing (it's not a YAML-facing field) rather than something this schema parses.
 */
export type RawLiveStrategyConfig =
  | Strategy1Config
  | Strategy1WsConfig
  | Strategy2Config
  | Omit<Strategy3aConfig, 'tpVariant'>
  | Strategy4_1aConfig
  | Strategy4_2aConfig
  | Strategy6Config

const paramsByName = new Map(CANONICAL_PARAMS.map(p => [p.name, p]))

function liveShapeFor(strategyId: (typeof ALL_STRATEGY_IDS)[number]): Record<string, z.ZodType> {
  const def = STRATEGY_DEFS[strategyId]
  const shape: Record<string, z.ZodType> = {
    id: z.literal(strategyId),
    enabled: z.boolean().default(false),
  }

  for (const paramName of def.params) {
    const param = paramsByName.get(paramName)
    if (!param) throw new Error(`Unknown canonical param '${paramName}' referenced by ${strategyId}`)
    if (!param.liveKey) continue // backtest-only param — no live representation
    shape[param.liveKey] = zodNumberFor(param, defaultFor(param, strategyId), strategyId)
  }

  if (def.liveExtra) Object.assign(shape, def.liveExtra)
  return shape
}

// zod v4's .refine() returns `this` (same concrete object type), so every entry stays a
// plain ZodObject — no separate "refined" wrapper type to union over.
function objectFor(strategyId: (typeof ALL_STRATEGY_IDS)[number]) {
  return applyCrossFieldBounds(z.object(liveShapeFor(strategyId)).strict(), strategyId, 'live')
}

const liveObjects = ALL_STRATEGY_IDS.map(id => objectFor(id))

/**
 * Generated live strategy schema: discriminated union over all 7 live strategy ids. Cast
 * to `RawLiveStrategyConfig` for the same reason as the backtest schema — the shape is
 * built dynamically from the registry, so per-variant literal keys aren't inferred.
 */
export const GeneratedLiveStrategySchema = z.discriminatedUnion(
  'id',
  liveObjects as unknown as [(typeof liveObjects)[number], ...(typeof liveObjects)[number][]]
) as unknown as z.ZodType<RawLiveStrategyConfig>
