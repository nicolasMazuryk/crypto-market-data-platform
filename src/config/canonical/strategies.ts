import { z } from 'zod'

import type { StrategyId } from '../../execution/strategies/types.js'
import { CANONICAL_PARAMS } from './params.js'

export interface StrategyDef {
  hasBacktest: boolean
  /** Names of CANONICAL_PARAMS rows this strategy uses. */
  params: string[]
  /** Extra zod fields for the backtest shape that aren't in the bridge table. */
  btExtra?: Record<string, z.ZodType>
  /** Extra zod fields for the live shape that aren't in the bridge table. */
  liveExtra?: Record<string, z.ZodType>
  /**
   * Cross-field invariant: `greater` must be > `lesser`. Expressed via canonical param
   * names (not per-side keys) so one definition applies to both the backtest and live
   * generated shapes via `applyCrossFieldBounds`.
   */
  crossFieldBounds?: { greater: string; lesser: string }[]
}

const paramsByName = new Map(CANONICAL_PARAMS.map(p => [p.name, p]))

function numField(c: unknown, key: string): number {
  const v = (c as Record<string, unknown>)[key]
  if (typeof v !== 'number') throw new Error(`expected numeric field '${key}'`)
  return v
}

/**
 * Apply a strategy's `crossFieldBounds` as `.refine()` checks on a generated zod object,
 * resolving each canonical param name to its btKey/liveKey for the given side.
 */
export function applyCrossFieldBounds<T extends z.ZodType>(schema: T, strategyId: StrategyId, side: 'bt' | 'live'): T {
  const bounds = STRATEGY_DEFS[strategyId].crossFieldBounds
  if (!bounds) return schema

  // zod v4's .refine() returns `this` (same concrete object type), so the running
  // schema stays assignable to T across the loop — safe to cast back at the end.
  let result: z.ZodType = schema
  for (const { greater, lesser } of bounds) {
    const greaterParam = paramsByName.get(greater)
    const lesserParam = paramsByName.get(lesser)
    if (!greaterParam || !lesserParam) {
      throw new Error(`Unknown canonical param in crossFieldBounds for ${strategyId}: '${greater}'/'${lesser}'`)
    }
    const greaterKey: string | undefined = side === 'bt' ? greaterParam.btKey : greaterParam.liveKey
    const lesserKey: string | undefined = side === 'bt' ? lesserParam.btKey : lesserParam.liveKey
    if (greaterKey === undefined || lesserKey === undefined) {
      throw new Error(`crossFieldBounds param has no ${side} key for ${strategyId}: '${greater}'/'${lesser}'`)
    }
    const gKey = greaterKey
    const lKey = lesserKey
    result = result.refine(c => numField(c, gKey) > numField(c, lKey), {
      message: `${gKey} must be greater than ${lKey}`,
    })
  }
  return result as T
}

const FUNDING_APPLIED_ON_SAME_SECOND = { funding_applied_on_same_second: z.boolean() }

export const STRATEGY_DEFS: Record<StrategyId, StrategyDef> = {
  strategy_1: {
    hasBacktest: true,
    params: [
      'negative_funding_threshold_percent',
      'entry_offset_seconds',
      'exit_offset_seconds',
      'amount_usd',
      'leverage',
    ],
    btExtra: { direction: z.literal('long').default('long'), ...FUNDING_APPLIED_ON_SAME_SECOND },
  },
  strategy_1_ws: {
    hasBacktest: false,
    params: [
      'negative_funding_threshold_percent',
      'entry_offset_seconds',
      'funding_fee_timeout_seconds',
      'amount_usd',
      'leverage',
    ],
  },
  strategy_2: {
    hasBacktest: true,
    params: [
      'negative_funding_threshold_percent',
      'entry_offset_seconds',
      'retracement_pct',
      'deadline_seconds',
      'sl_multiplier',
      'funding_fee_timeout_seconds',
      'amount_usd',
      'leverage',
    ],
    btExtra: { direction: z.literal('long').default('long'), ...FUNDING_APPLIED_ON_SAME_SECOND },
  },
  strategy_3a: {
    hasBacktest: true,
    params: [
      'negative_funding_threshold_percent',
      'entry_offset_seconds',
      'stop_loss_percent',
      'tp_variant_a_multiplier',
      'tp_variant_b_offset_percent',
      'deadline_seconds',
      'amount_usd',
      'leverage',
    ],
    btExtra: {
      direction: z.literal('short').default('short'),
      tp_mode: z.enum(['A', 'B']),
      ...FUNDING_APPLIED_ON_SAME_SECOND,
    },
  },
  strategy_4_1a: {
    hasBacktest: true,
    params: [
      'negative_funding_threshold_percent',
      'entry_offset_seconds',
      'ladder_count',
      'ladder_top_mult',
      'ladder_bottom_mult',
      'take_profit_pct',
      'deadline_seconds',
      'sl_multiplier',
      'amount_usd',
      'leverage',
    ],
    btExtra: { direction: z.literal('long').default('long'), ...FUNDING_APPLIED_ON_SAME_SECOND },
    crossFieldBounds: [{ greater: 'ladder_bottom_mult', lesser: 'ladder_top_mult' }],
  },
  strategy_4_2a: {
    hasBacktest: true,
    params: [
      'negative_funding_threshold_percent',
      'entry_offset_seconds',
      'limit_offset_mult',
      'take_profit_pct',
      'deadline_seconds',
      'sl_multiplier',
      'amount_usd',
      'leverage',
    ],
    btExtra: { direction: z.literal('long').default('long'), ...FUNDING_APPLIED_ON_SAME_SECOND },
    crossFieldBounds: [{ greater: 'sl_multiplier', lesser: 'limit_offset_mult' }],
  },
  strategy_6: {
    hasBacktest: false,
    params: [
      'entry_offset_seconds',
      'funding_fee_timeout_seconds',
      'post_funding_tp_multiplier',
      'sl_multiplier',
      'deadline_seconds',
      'main_amount_usd',
      'leverage',
      'funding_threshold_percent',
    ],
    // mainSide is strategy_6-specific: it has no canonical shared meaning, so it's kept
    // as-is rather than folded into the shared bridge-table row.
    liveExtra: {
      mainSide: z.enum(['long', 'short']),
    },
  },
}

export const ALL_STRATEGY_IDS = Object.keys(STRATEGY_DEFS) as StrategyId[]
export const BACKTEST_STRATEGY_IDS = ALL_STRATEGY_IDS.filter(id => STRATEGY_DEFS[id].hasBacktest)
