import { z } from 'zod'

import type { StrategyId } from '../../execution/strategies/types.js'

export interface StrategyDef {
  hasBacktest: boolean
  /** Names of CANONICAL_PARAMS rows this strategy uses. */
  params: string[]
  /** Extra zod fields for the backtest shape that aren't in the bridge table. */
  btExtra?: Record<string, z.ZodType>
  /** Extra zod fields for the live shape that aren't in the bridge table. */
  liveExtra?: Record<string, z.ZodType>
  /** Cross-field invariant applied via .refine() on the generated live shape. */
  liveRefine?: (config: Record<string, unknown>) => boolean
  liveRefineMessage?: string
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
    liveRefine: c => (c.ladderBottomMult as number) > (c.ladderTopMult as number),
    liveRefineMessage: 'ladderBottomMult must be greater than ladderTopMult',
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
    liveRefine: c => (c.slMultiplier as number) > (c.limitOffsetMult as number),
    liveRefineMessage: 'slMultiplier must be greater than limitOffsetMult',
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
    ],
    // mainSide and funding_threshold are strategy_6-specific: mainSide has no canonical
    // shared meaning, and funding_threshold here is a bidirectional (not
    // negative-only-signed) threshold — a different concept from
    // negative_funding_threshold_percent, so it's kept as-is rather than folded into the
    // shared bridge-table row.
    liveExtra: {
      mainSide: z.enum(['long', 'short']),
      funding_threshold: z.number().default(0),
    },
  },
}

export const ALL_STRATEGY_IDS = Object.keys(STRATEGY_DEFS) as StrategyId[]
export const BACKTEST_STRATEGY_IDS = ALL_STRATEGY_IDS.filter(id => STRATEGY_DEFS[id].hasBacktest)
