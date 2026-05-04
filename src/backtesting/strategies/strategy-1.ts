import type { FeeSchedule, Strategy1Config } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'

/**
 * Strategy 1: Negative Funding LONG - Instant Exit
 *
 * Enter LONG at T_funding - entry_offset, exit at T_funding + exit_offset.
 * Collect funding fee, minimize delta exposure.
 */
export class Strategy1 implements BaseStrategy {
  readonly id = 'strategy_1'
  private config!: Strategy1Config
  private feeSchedule!: FeeSchedule

  initialize(config: Strategy1Config, feeSchedule: FeeSchedule, slippage?: number): void {
    void slippage
    this.config = config
    this.feeSchedule = feeSchedule
  }

  shouldTrigger(event: FundingEvent): boolean {
    // Trigger when funding rate is negative and |F| >= threshold
    return event.funding_rate < 0 && Math.abs(event.funding_rate) >= this.config.funding_threshold
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null {
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const exitTime = new Date(event.funding_time.getTime() + this.config.exit_offset_seconds * 1000)

    const entryTs = toClickHouseDateTime(entryTime)
    const exitTs = toClickHouseDateTime(exitTime)
    const fundingTs = toClickHouseDateTime(event.funding_time)

    const entryCandle = data.getRowAt(entryTs)
    const exitCandle = data.getRowAt(exitTs)

    if (!entryCandle || !exitCandle) return null

    // BUY MARKET at entry (fills at ask_open)
    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry')
    if (!entryFill) return null

    // SELL MARKET at exit (fills at bid_open)
    const exitFill = fillMarketOrder('sell', exitCandle, 1, 'exit')
    if (!exitFill) return null

    const applyFunding = shouldApplyFunding({
      entryTs,
      exitTs,
      fundingTs,
      fundingAppliedOnSameSecond: this.config.funding_applied_on_same_second,
    })

    const pnl = calculatePnl({
      direction: 'long',
      entryPrice: entryFill.price,
      exitPrice: exitFill.price,
      fundingRate: event.funding_rate,
      appliedFraction: fundingFraction(applyFunding),
      entryFeeType: 'taker',
      exitFeeType: 'taker',
      feeSchedule: this.feeSchedule,
    })

    const holdDuration = (exitTime.getTime() - entryTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: event.exchange,
      symbol: event.symbol,
      funding_time: event.funding_time,
      funding_rate: event.funding_rate,
      entry_price: entryFill.price,
      exit_price: exitFill.price,
      pnl,
      exit_reason: 'MARKET_EXIT',
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: applyFunding,
    }
  }
}
