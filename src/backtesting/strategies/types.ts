import type {
  ExitReason,
  BacktestError,
  StrategyConfig,
  FeeSchedule,
  FundingSettlementConfig,
} from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import type { PnlBreakdown } from '../pnl/types.js'
import type { TimeGatedWindow } from '../engine/lookahead-guard.js'

/**
 * Engine-supplied localization context (§3.1/§3.2). The runner performs the one sanctioned
 * lookahead (drop localization to W's edge) and hands strategies the resulting T_drop plus a
 * time-gated window for causal, guard-enforced reads.
 */
export interface LookaheadContext {
  /** Localized T_drop, or the window edge on fallback. */
  tDropTs: string
  /** True when no qualifying drop candle was localized (fallback edge used). */
  noDropLocalized: boolean
  /** Time-gated view of the data window; strategies advance the gate as they read forward. */
  gated: TimeGatedWindow
}

/** Result of a single trade execution */
export interface TradeResult {
  /** Strategy ID */
  strategy_id: string
  /** Exchange traded on */
  exchange: string
  /** Symbol traded */
  symbol: string
  /** Funding event timestamp */
  funding_time: Date
  /** Funding rate */
  funding_rate: number
  /** Entry price (or weighted average for ladder) */
  entry_price: number
  /** Exit price */
  exit_price: number
  /** P&L breakdown */
  pnl: PnlBreakdown
  /** Why the trade exited */
  exit_reason: ExitReason
  /** Seconds from entry to exit */
  hold_duration: number
  /** Number of limit orders filled (ladder strategies) */
  fill_count: number
  /** Whether funding was received/paid */
  funding_received: boolean
  /** Number of funding events collected (spot-futures only) */
  funding_events_collected?: number
  /** Sum of all collected funding rates (spot-futures only) */
  cumulative_funding_rate?: number
  /** (perp_entry - spot_entry) / spot_entry at T_entry (spot-futures only) */
  entry_spread?: number
  /** (perp_exit - spot_exit) / spot_entry at exit (spot-futures only) */
  exit_spread?: number
  /** Actual exit time of the trade; used by the runner to prevent re-entry while a position is open */
  exit_time?: Date
  /** Localized T_drop timestamp (strategy_1, strategy_2 only) */
  real_settlement_ts?: string
  /** Whether a qualifying drop candle was localized (false = fallback to the window edge) */
  real_settlement_detected?: boolean
  /** `T_drop - T_settle` in seconds; `null` on fallback (strategy_1, strategy_2 only) */
  t_drop_offset_s?: number | null
}

/** Base strategy interface that all strategies implement */
export interface BaseStrategy {
  /** Strategy identifier */
  readonly id: string

  /** Initialize with merged config */
  initialize(
    config: StrategyConfig,
    feeSchedule: FeeSchedule,
    slippage: number,
    orderLatencyMs: number,
    fundingSettlement?: FundingSettlementConfig
  ): void

  /** Check if this funding event meets selection criteria */
  shouldTrigger(event: FundingEvent): boolean

  /**
   * Execute the strategy.
   * - `TradeResult` — a position was taken and reached a terminal state.
   * - `BacktestError` — a representable terminal (§12.2 error_code) such as a ladder no-fill
   *   or an expired entry limit; comparable to the live engine's error_code channel.
   * - `null` — no trade / data absence (nothing to represent).
   *
   * `context` carries the engine-localized T_drop and a time-gated window (§3.2). Drop-consuming
   * strategies (S1, S2) require it; strategies that key off T_settle ignore it and read `data`.
   */
  execute(event: FundingEvent, data: OHLCWindow, context?: LookaheadContext): TradeResult | BacktestError | null
}
