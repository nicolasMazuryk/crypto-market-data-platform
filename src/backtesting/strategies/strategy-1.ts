import type { FeeSchedule, Strategy1Config, FundingSettlementConfig } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { detectRealFundingSettlement } from '../data/funding-settlement.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'

/**
 * Strategy 1: Negative Funding LONG - Instant Exit
 *
 * Enter LONG at T_funding - entry_offset, exit at real_settlement_ts + exit_offset.
 * Uses price-drop detection to approximate the real funding accrual time, avoiding
 * false-positive funding credits when live settlement is delayed past the exit.
 */
export class Strategy1 implements BaseStrategy {
  readonly id = 'strategy_1'
  private config!: Strategy1Config
  private feeSchedule!: FeeSchedule
  private fundingSettlement: FundingSettlementConfig = {
    detection_window_seconds: 10,
    tp_post_settlement_buffer_seconds: 1,
  }

  initialize(
    config: Strategy1Config,
    feeSchedule: FeeSchedule,
    slippage?: number,
    fundingSettlement?: FundingSettlementConfig
  ): void {
    void slippage
    this.config = config
    this.feeSchedule = feeSchedule
    if (fundingSettlement) this.fundingSettlement = fundingSettlement
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate * 100 <= -Math.abs(this.config.negative_funding_threshold_percent)
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null {
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const entryTs = toClickHouseDateTime(entryTime)

    const entryCandle = data.getRowAt(entryTs)
    if (!entryCandle) return null

    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry')
    if (!entryFill) return null

    const settlement = detectRealFundingSettlement(
      data,
      event.funding_time,
      this.fundingSettlement.detection_window_seconds
    )
    const settlementTime = new Date(settlement.settlementTs.replace(' ', 'T') + 'Z')
    const exitTime = new Date(settlementTime.getTime() + this.config.exit_offset_seconds * 1000)

    const exitTs = toClickHouseDateTime(exitTime)

    const exitCandle = data.getRowAt(exitTs)
    if (!exitCandle) return null

    const exitFill = fillMarketOrder('sell', exitCandle, 1, 'exit')
    if (!exitFill) return null

    const applyFunding = shouldApplyFunding({
      entryTs,
      exitTs,
      fundingTs: settlement.settlementTs,
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
      exit_reason: 'timed',
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: applyFunding,
      real_settlement_ts: settlement.settlementTs,
      real_settlement_detected: settlement.detected,
      real_settlement_drop: settlement.dropMagnitude,
    }
  }
}
