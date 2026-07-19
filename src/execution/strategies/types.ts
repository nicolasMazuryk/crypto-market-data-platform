import type { Exchange, FundingInterval } from '../types/exchange.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadata } from '../markets/types.js'

export type StrategyId =
  | 'strategy_1'
  | 'strategy_1_ws'
  | 'strategy_2'
  | 'strategy_3a'
  | 'strategy_3b'
  | 'strategy_4_1a'
  | 'strategy_4_2a'
  | 'strategy_6'

export type Side = 'long' | 'short'

export interface Strategy1Config {
  id: 'strategy_1'
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  exitOffsetSeconds: number
  amountUsd: number
  leverage: number
}

/** Strategy 1 WS: identical to strategy_1 but exits on the funding-fee WS event instead of a fixed offset. */
export interface Strategy1WsConfig {
  id: 'strategy_1_ws'
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  /** Hard fallback: force market close this many seconds after fundingTs if no fee event received. */
  fundingFeeTimeoutSeconds: number
  amountUsd: number
  leverage: number
}

/** Strategy 2: Negative Funding LONG, retracement TP exit. */
export interface Strategy2Config {
  id: 'strategy_2'
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  /** Retracement level 0–1: tpPrice = P_low + (P_anchor − P_low) × retracementPct */
  retracementPct: number
  deadlineSeconds: number
  /** SL distance multiplier: slPct = |F%| × slMultiplier */
  slMultiplier: number
  /** Hard fallback: begin retracement polling this many seconds after fundingTs if no fee event received. */
  fundingFeeTimeoutSeconds: number
  amountUsd: number
  leverage: number
}

/** Strategy 6: Post-funding directional (LONG or SHORT), WS-gated entry. Live-only. */
export interface Strategy6Config {
  id: 'strategy_6'
  enabled: boolean
  /** Trade direction — required, no default. */
  mainSide: Side
  /** Signed funding-rate threshold. Positive ⇒ fire when rate ≥ threshold. Negative ⇒ fire when rate ≤ threshold. 0 ⇒ always-on. Independent of `mainSide`. */
  funding_threshold: number
  /** Seconds before T_funding to place the PRE_FUNDING order. */
  entryOffsetSeconds: number
  /** Hard fallback: close PRE_FUNDING and abort this many seconds after fundingTs if no fee event. */
  fundingFeeTimeoutSeconds: number
  /** TP multiplier: tpPct = |F%| × tpMultiplier */
  tpMultiplier: number
  /** SL multiplier: slPct = |F%| × slMultiplier */
  slMultiplier: number
  /** Deadline in seconds after T_funding. */
  deadlineSeconds: number
  mainAmountUsd: number
  leverage: number
}

export interface Strategy3SharedConfig {
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  stopLossPercent: number
  tpVariantAMultiplier: number
  tpVariantBOffsetPercent: number
  deadlineSeconds: number
  amountUsd: number
  leverage: number
}

export interface Strategy3aConfig extends Strategy3SharedConfig {
  id: 'strategy_3a'
  tpVariant: 'A'
}

export interface Strategy3bConfig extends Strategy3SharedConfig {
  id: 'strategy_3b'
  tpVariant: 'B'
}

/** Strategy 4.1a: Ladder LONG, no funding accrual (limits fill after T_funding). */
export interface Strategy4_1aConfig {
  id: 'strategy_4_1a'
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  ladderCount: number
  /** Top-of-ladder offset multiplier: topPrice = P × (1 − |F%| × ladderTopMult / 100) */
  ladderTopMult: number
  /** Bottom-of-ladder offset multiplier */
  ladderBottomMult: number
  /** Take-profit in percent (e.g. 0.2 for 0.2%) anchored to weighted-avg fill price */
  takeProfitPct: number
  deadlineSeconds: number
  /** SL distance multiplier: slPct = |F%| × slMultiplier */
  slMultiplier: number
  amountUsd: number
  leverage: number
}

/** Strategy 4.2a: Single-limit LONG, no funding accrual. */
export interface Strategy4_2aConfig {
  id: 'strategy_4_2a'
  enabled: boolean
  negativeFundingThresholdPercent: number
  entryOffsetSeconds: number
  /** Limit price offset multiplier: limitPrice = P × (1 − |F%| × limitOffsetMult / 100) */
  limitOffsetMult: number
  /** Take-profit in percent (e.g. 0.2 for 0.2%) anchored to fill price */
  takeProfitPct: number
  deadlineSeconds: number
  /** SL distance multiplier: slPct = |F%| × slMultiplier; must be > limitOffsetMult */
  slMultiplier: number
  amountUsd: number
  leverage: number
}

export type StrategyConfig =
  | Strategy1Config
  | Strategy1WsConfig
  | Strategy2Config
  | Strategy3aConfig
  | Strategy3bConfig
  | Strategy4_1aConfig
  | Strategy4_2aConfig
  | Strategy6Config

/**
 * How the entry order is placed.
 * `market` (default): single market order at entryAt.
 * `limit`: single limit order at priceOffsetPct below (long) or above (short) refPrice.
 * `ladder_limit`: N limit orders spread across a price range; fills tracked independently.
 * `pre_funding_then_main`: tiny opposite-direction order pre-funding to subscribe to WS events,
 *   then a full-size main order placed on the ws.funding_fee event (strategy_6).
 */
export type EntryPolicy =
  | { kind: 'market' }
  | { kind: 'limit'; priceOffsetPct: number; expireAt: number }
  | { kind: 'ladder_limit'; rungs: { priceOffsetPct: number; qtyFraction: number }[]; expireAt: number }
  | {
      kind: 'pre_funding_then_main'
      preFundingSide: Side
      preFundingVolume: number
      mainSide: Side
      mainVolume: number
    }

export type ExitPolicy =
  | {
      kind: 'timed'
      exitAt: number
    }
  | {
      kind: 'sl_tp_deadline'
      slPct: number
      tpPct: number
      deadlineAt: number
      /** Audit/persistence label only — the manager uses `tpPct` directly and never reads this field. */
      tpVariant: 'A' | 'B'
    }
  | {
      kind: 'sl_tp_deadline_retracement'
      /** SL distance in percent (e.g. 0.4 for 0.4%) anchored to fill price. */
      slPct: number
      /** Retracement level 0–1: tpPrice = P_low + (anchorPrice − P_low) × retracementPct */
      retracementPct: number
      /** Reference price captured at decision time (≈ P_funding for the live engine). */
      anchorPrice: number
      deadlineAt: number
      /** Unix-ms of the funding event; P_low tracking begins at this timestamp. */
      fundingTs: number
    }
  | {
      kind: 'sl_tp_deadline_retracement_funding_event'
      slPct: number
      retracementPct: number
      anchorPrice: number
      deadlineAt: number
      fundingTs: number
      /** Retracement tracker arms on ws.funding_fee event; this is the hard fallback deadline. */
      timeoutAt: number
    }
  | {
      kind: 'funding_fee_event'
      /** Funding timestamp this exit is bound to. */
      fundingTs: number
      /** Hard fallback: force market close this many ms after fundingTs if no fee event received. */
      timeoutAt: number
    }
  | {
      kind: 'sl_tp_deadline_post_funding_event'
      /** TP multiplier: tpPct = |fundingRatePercent| × tpMultiplier */
      tpMultiplier: number
      /** SL multiplier: slPct = |fundingRatePercent| × slMultiplier */
      slMultiplier: number
      /** Unix-ms of the funding event; MAIN entry is placed on this event. */
      fundingTs: number
      /** Hard fallback ms: close PRE_FUNDING and abort if no fee event by this time. */
      timeoutAt: number
      /** Deadline for TP/SL exit (Unix-ms). */
      deadlineAt: number
    }

export interface TradeIntent {
  id: string
  strategy: StrategyId
  exchange: Exchange
  symbol: string
  exchangeSymbol: string
  side: Side
  amountUsd: number
  leverage: number
  volume: number
  fundingRate: number
  fundingRatePercent: number
  fundingInterval: FundingInterval
  nextFundingTimestamp: number
  nextFundingDatetime: string
  decidedAt: number
  entryAt: number
  /** Defaults to `{ kind: 'market' }` when absent; explicit for limit/ladder strategies. */
  entryPolicy?: EntryPolicy
  exitPolicy: ExitPolicy
}

export interface EvalContext {
  now: number
  exchange: Exchange
  fundingEvent: {
    symbol: string
    nextFundingTimestamp: number
    fundingInterval: FundingInterval
  }
  snapshots: Map<string, FundingSnapshot>
  markets: (symbol: string) => MarketMetadata | undefined
  config: StrategyConfig
}

export interface StrategyRule {
  readonly id: StrategyId
  evaluate(ctx: EvalContext): TradeIntent[]
}

export interface StrategyEvaluator {
  evaluate(exchange: Exchange, fundingEventSymbol: string): TradeIntent[]
}
