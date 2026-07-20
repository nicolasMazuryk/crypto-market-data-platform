import type { StrategyId } from '../../execution/strategies/types.js'

export type CanonicalUnit = 'percent' | 'fraction' | 'seconds' | 'ms' | 'multiplier' | 'usd' | 'integer' | 'enum'
export type CanonicalSign = 'signed' | 'absolute' | 'n/a'

/**
 * Pre-existing zod-level validation carried over verbatim from the current hand-written
 * schemas (e.g. retracementPct's 0-1 clamp, strategy_6's positive() fields). Distinct from
 * `bounds` below: this is behavior that already exists today, not new enforcement.
 */
export interface CanonicalHardConstraint {
  positive?: boolean
  min?: number
  max?: number
}

export interface CanonicalParam {
  /** Canonical doc name, e.g. 'negative_funding_threshold_percent'. */
  name: string
  /** snake_case backtest key. Absent when the param has no backtest representation. */
  btKey?: string
  /** camelCase live key. Absent only for the 7 backtest-only BaseConfig rows. */
  liveKey?: string
  unit: CanonicalUnit
  sign: CanonicalSign
  /**
   * Default value. A single number when uniform across every strategy that uses this
   * param. A per-strategy map when strategies currently diverge (avoids silently
   * harmonizing values Task 05 wasn't asked to touch — see OQ-7 for the one default this
   * task DOES reconcile). Omit a strategy's entry (or the whole default) to mean
   * "required, no default".
   */
  default?: number | Partial<Record<StrategyId, number>>
  hardConstraint?: CanonicalHardConstraint
  /** §11.1 hard bounds, enforced on both generated schemas via zodNumberFor/boundsFor. */
  bounds?: {
    min?: number
    max?: number
    exclusiveMin?: boolean
    exclusiveMax?: boolean
    note?: string
    /** Unit-specific error message for the min bound (§11.2), overriding zod's generic message. */
    minMessage?: string
    /** Unit-specific error message for the max bound (§11.2), overriding zod's generic message. */
    maxMessage?: string
  }
  /** Per-strategy override of `bounds` above (e.g. sl_multiplier differs for S4.2a). */
  perStrategyBounds?: Partial<
    Record<StrategyId, { min?: number; max?: number; exclusiveMin?: boolean; exclusiveMax?: boolean }>
  >
  /** True for the 7 §10.2 rows with no liveKey; scoped to BaseConfig, not per-strategy. */
  backtestOnly?: boolean
  perExchangeOverride?: { exchange: string; strategyId?: string; value: number }[]
}

/** Resolve the default for a param for a given strategy. Undefined = required field. */
export function defaultFor(param: CanonicalParam, strategyId: StrategyId): number | undefined {
  if (param.default === undefined) return undefined
  if (typeof param.default === 'number') return param.default
  return param.default[strategyId]
}

/**
 * Resolve the bounds for a param for a given strategy — perStrategyBounds override wins.
 * `strategyId` is omitted for backtest-only BaseConfig params, which have no per-strategy
 * dimension.
 */
export function boundsFor(param: CanonicalParam, strategyId?: StrategyId): CanonicalParam['bounds'] {
  if (strategyId === undefined) return param.bounds
  return param.perStrategyBounds?.[strategyId] ?? param.bounds
}

export const CANONICAL_PARAMS: CanonicalParam[] = [
  {
    name: 'negative_funding_threshold_percent',
    btKey: 'negative_funding_threshold_percent',
    liveKey: 'negativeFundingThresholdPercent',
    unit: 'percent',
    sign: 'signed',
    // OQ-7: canonicalized to -0.4 for all of strategy_1/1_ws/2/3a/4.1a/4.2a (kills the
    // -0.5 drift previously on strategy_1/1_ws/3a).
    default: -0.4,
    bounds: { min: -5.0, max: 0, exclusiveMax: true },
  },
  {
    name: 'entry_offset_seconds',
    btKey: 'entry_offset_seconds',
    liveKey: 'entryOffsetSeconds',
    unit: 'seconds',
    sign: 'absolute',
    default: {
      strategy_1: 10,
      strategy_1_ws: 10,
      strategy_2: 5,
      strategy_3a: 10,
      strategy_4_1a: 5,
      strategy_4_2a: 5,
      strategy_6: 10,
    },
    hardConstraint: { positive: true },
    bounds: { min: 2 },
  },
  {
    name: 'exit_offset_seconds',
    btKey: 'exit_offset_seconds',
    liveKey: 'exitOffsetSeconds',
    unit: 'seconds',
    sign: 'absolute',
    // R2: default bumped 2 -> 6 to satisfy the new >=6 bound.
    default: { strategy_1: 6 },
    bounds: { min: 6 },
  },
  {
    name: 'retracement_pct',
    btKey: 'retracement_pct',
    liveKey: 'retracementPct',
    unit: 'fraction',
    sign: 'absolute',
    default: { strategy_2: 0.5 },
    hardConstraint: { min: 0, max: 1 },
    bounds: {
      min: 0,
      exclusiveMin: true,
      max: 1,
      maxMessage:
        'retracement_pct must be a fraction (0 < v ≤ 1.0); a value above 1.0 looks like a percent, not a fraction',
    },
  },
  {
    name: 'deadline_seconds',
    btKey: 'deadline_seconds',
    liveKey: 'deadlineSeconds',
    unit: 'seconds',
    sign: 'absolute',
    default: {
      strategy_2: 60,
      strategy_3a: 300,
      strategy_4_1a: 60,
      strategy_4_2a: 60,
      strategy_6: 3300,
    },
    // R3: 10..3600.
    bounds: { min: 10, max: 3600 },
  },
  {
    name: 'sl_multiplier',
    btKey: 'sl_multiplier',
    liveKey: 'slMultiplier',
    unit: 'multiplier',
    sign: 'absolute',
    default: {
      strategy_2: 1.0,
      strategy_4_1a: 1.0,
      strategy_4_2a: 1.5,
      strategy_6: 1.0,
    },
    bounds: { min: 0.5, max: 4.0 },
    perStrategyBounds: { strategy_4_2a: { min: 1.0, max: 4.0 } },
  },
  {
    name: 'stop_loss_percent',
    btKey: 'stop_loss_percent',
    liveKey: 'stopLossPercent',
    unit: 'percent',
    sign: 'absolute',
    default: { strategy_3a: 1 },
    bounds: { min: 0.2, max: 5.0 },
  },
  {
    name: 'tp_variant_a_multiplier',
    btKey: 'tp_multiplier',
    liveKey: 'tpVariantAMultiplier',
    unit: 'multiplier',
    sign: 'absolute',
    default: { strategy_3a: 1.5 },
  },
  {
    name: 'tp_variant_b_offset_percent',
    btKey: 'tp_addend_pct',
    liveKey: 'tpVariantBOffsetPercent',
    unit: 'percent',
    sign: 'absolute',
    default: { strategy_3a: 0.4 },
  },
  {
    name: 'take_profit_pct',
    btKey: 'take_profit_pct',
    liveKey: 'takeProfitPct',
    unit: 'percent',
    sign: 'absolute',
    default: { strategy_4_1a: 0.2, strategy_4_2a: 0.2 },
    bounds: {
      min: 0.05,
      max: 5.0,
      minMessage: 'unit_suspect_fraction: value looks like a fraction; percent expected',
    },
  },
  {
    name: 'ladder_count',
    btKey: 'ladder_count',
    liveKey: 'ladderCount',
    unit: 'integer',
    sign: 'absolute',
    default: { strategy_4_1a: 5 },
    hardConstraint: { min: 2 },
    // hardConstraint.min:2 above is redundant with this bound; left as-is (harmless).
    bounds: { min: 2, max: 20 },
  },
  {
    name: 'ladder_top_mult',
    btKey: 'ladder_top_mult',
    liveKey: 'ladderTopMult',
    unit: 'multiplier',
    sign: 'absolute',
    default: { strategy_4_1a: 0.5 },
  },
  {
    name: 'ladder_bottom_mult',
    btKey: 'ladder_bottom_mult',
    liveKey: 'ladderBottomMult',
    unit: 'multiplier',
    sign: 'absolute',
    default: { strategy_4_1a: 1.5 },
  },
  {
    name: 'limit_offset_mult',
    btKey: 'limit_offset_mult',
    liveKey: 'limitOffsetMult',
    unit: 'multiplier',
    sign: 'absolute',
    default: { strategy_4_2a: 0.75 },
  },
  {
    name: 'funding_fee_timeout_seconds',
    // No bt equivalent: backtest has no WS funding-fee event to time out on.
    liveKey: 'fundingFeeTimeoutSeconds',
    unit: 'seconds',
    sign: 'absolute',
    default: { strategy_1_ws: 30, strategy_2: 30, strategy_6: 30 },
    hardConstraint: { positive: true },
    bounds: { min: 5, max: 120 },
    // Base default 30 already matches current live schema.ts defaults; OKX runs these
    // three strategies at 45s in the deployed per-instance YAMLs. Data only — not
    // applied automatically by generate-live.ts (no exchange dimension in the strategy
    // union today).
    perExchangeOverride: [
      { exchange: 'okx', strategyId: 'strategy_1_ws', value: 45 },
      { exchange: 'okx', strategyId: 'strategy_2', value: 45 },
      { exchange: 'okx', strategyId: 'strategy_6', value: 45 },
    ],
  },
  {
    name: 'post_funding_tp_multiplier',
    // strategy_6-only concept (TP = |F%| x multiplier against the post-funding MAIN
    // entry); distinct from strategy_3a's tp_variant_a_multiplier (different liveKey,
    // different default) so kept as its own row rather than shared.
    liveKey: 'tpMultiplier',
    unit: 'multiplier',
    sign: 'absolute',
    default: { strategy_6: 0.5 },
    hardConstraint: { positive: true },
  },
  {
    name: 'amount_usd',
    btKey: 'amount_usd',
    liveKey: 'amountUsd',
    unit: 'usd',
    sign: 'absolute',
    default: {
      strategy_1: 20,
      strategy_1_ws: 20,
      strategy_2: 20,
      strategy_3a: 20,
      strategy_4_1a: 20,
      strategy_4_2a: 20,
    },
  },
  {
    name: 'main_amount_usd',
    // strategy_6-only: liveKey differs from the shared amountUsd row and has no default
    // (required) in the live schema today.
    liveKey: 'mainAmountUsd',
    unit: 'usd',
    sign: 'absolute',
    hardConstraint: { positive: true },
  },
  {
    name: 'leverage',
    btKey: 'leverage',
    liveKey: 'leverage',
    unit: 'multiplier',
    sign: 'absolute',
    default: {
      strategy_1: 4,
      strategy_1_ws: 4,
      strategy_2: 4,
      strategy_3a: 4,
      strategy_4_1a: 4,
      strategy_4_2a: 4,
      // strategy_6 has no live default today (required, positive()).
    },
    hardConstraint: { positive: true },
  },

  // ---- Backtest-only BaseConfig rows (§10.2) ----
  {
    name: 'market_slippage_pct',
    unit: 'percent',
    sign: 'absolute',
    default: 0.05,
    backtestOnly: true,
  },
  {
    name: 'order_latency_ms',
    unit: 'ms',
    sign: 'absolute',
    default: 1000,
    backtestOnly: true,
  },
  {
    name: 'ws_event_miss_rate',
    unit: 'fraction',
    sign: 'absolute',
    default: 0.02,
    backtestOnly: true,
  },
  {
    name: 'ws_exit_extra_delay_seconds',
    unit: 'seconds',
    sign: 'absolute',
    default: 2,
    backtestOnly: true,
  },
  {
    name: 'drop_search_window_seconds',
    unit: 'seconds',
    sign: 'absolute',
    default: 10,
    backtestOnly: true,
  },
  {
    name: 'drop_qualifier_funding_mult',
    unit: 'multiplier',
    sign: 'absolute',
    default: 0.5,
    backtestOnly: true,
  },
  {
    name: 'drop_qualifier_range_mult',
    unit: 'multiplier',
    sign: 'absolute',
    default: 3.0,
    backtestOnly: true,
  },
]

export const BACKTEST_ONLY_PARAMS: CanonicalParam[] = CANONICAL_PARAMS.filter(p => p.backtestOnly === true)
