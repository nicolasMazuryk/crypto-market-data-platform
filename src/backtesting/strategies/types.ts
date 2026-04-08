import type { ExitReason, StrategyConfig, FeeSchedule } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import type { PnlBreakdown } from '../pnl/types.js'

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
}

/** Base strategy interface that all strategies implement */
export interface BaseStrategy {
  /** Strategy identifier */
  readonly id: string

  /** Initialize with merged config */
  initialize(config: StrategyConfig, feeSchedule: FeeSchedule, slippage: number): void

  /** Check if this funding event meets selection criteria */
  shouldTrigger(event: FundingEvent): boolean

  /** Execute the strategy and return trade result (or null if no trade) */
  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null
}
