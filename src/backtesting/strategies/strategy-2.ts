import type { FeeSchedule, Strategy2Config, FundingSettlementConfig } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkLimitFill } from '../orders/limit-order.js'
import { checkStopFill } from '../orders/stop-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { detectRealFundingSettlement } from '../data/funding-settlement.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'
import type { ExitReason } from '../config/schema.js'

/**
 * Strategy 2: Negative Funding LONG - Retracement Exit
 *
 * Enter LONG at T_funding - entry_offset. After the drop, wait for a partial
 * retracement. Exit at retracement target, stop-loss, or deadline.
 * SL is active from entry+1s; TP only valid after max(T_low+1s, real_settlement_ts+buffer).
 */
export class Strategy2 implements BaseStrategy {
  readonly id = 'strategy_2'
  private config!: Strategy2Config
  private feeSchedule!: FeeSchedule
  private slippage = 0
  private fundingSettlement: FundingSettlementConfig = {
    detection_window_seconds: 10,
    tp_post_settlement_buffer_seconds: 1,
  }

  initialize(
    config: Strategy2Config,
    feeSchedule: FeeSchedule,
    slippage: number,
    fundingSettlement?: FundingSettlementConfig
  ): void {
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
    if (fundingSettlement) this.fundingSettlement = fundingSettlement
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate < 0 && Math.abs(event.funding_rate) >= this.config.funding_threshold
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null {
    const absF = Math.abs(event.funding_rate)
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)

    const entryTs = toClickHouseDateTime(entryTime)
    const fundingTs = toClickHouseDateTime(event.funding_time)
    const deadlineTs = toClickHouseDateTime(deadlineTime)

    const entryCandle = data.getRowAt(entryTs)
    if (!entryCandle) return null

    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry')
    if (!entryFill) return null

    const slPrice = entryFill.price * (1 - absF * this.config.sl_mult)

    const fundingCandle = data.getRowAt(fundingTs)
    if (fundingCandle?.bid_open == null) return null
    const pFunding = fundingCandle.bid_open

    // Simulate SL + dynamic TP online. P_low is learned only from candles already seen
    // after funding; the repriced TP becomes active on the following timestamp.
    const entryPlus1Ts = toClickHouseDateTime(new Date(entryTime.getTime() + 1000))
    const allPostEntryRows = data.getRowsInRange(entryPlus1Ts, deadlineTs)
    if (allPostEntryRows.length === 0) return null

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string } | undefined
    let pLow = Infinity
    let activeTpPrice: number | undefined
    let activeTpFrom: string | undefined

    for (const row of allPostEntryRows) {
      const slFill = checkStopFill('sell', slPrice, row, 1, this.slippage, 'sl')
      const tpFill =
        activeTpPrice !== undefined && activeTpFrom !== undefined && row.ts >= activeTpFrom
          ? checkLimitFill('sell', activeTpPrice, row, 1, 'tp')
          : null

      // Same-candle ambiguity is intentionally conservative: SL wins.
      if (slFill) {
        exit = { price: slFill.price, reason: 'SL_HIT', feeType: 'taker', ts: slFill.timestamp }
        break
      }
      if (tpFill) {
        exit = { price: tpFill.price, reason: 'TP_HIT', feeType: 'maker', ts: tpFill.timestamp }
        break
      }

      if (row.ts >= fundingTs && row.ts <= deadlineTs && row.bid_low !== null && row.bid_low < pLow) {
        pLow = row.bid_low
        if (pFunding > pLow) {
          activeTpPrice = pLow + (pFunding - pLow) * this.config.retracement_pct
          activeTpFrom = toClickHouseDateTime(new Date(new Date(row.ts.replace(' ', 'T') + 'Z').getTime() + 1000))
        }
      }
    }

    if (exit === undefined) {
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFill = fillMarketOrder('sell', deadlineCandle, 1, 'deadline')
        if (!deadlineFill) return null
        exit = { price: deadlineFill.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      } else {
        const lastRow = allPostEntryRows[allPostEntryRows.length - 1]
        if (!lastRow) return null
        const lastFill = fillMarketOrder('sell', lastRow, 1, 'deadline')
        if (!lastFill) return null
        exit = { price: lastFill.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      }
    }

    const settlement = detectRealFundingSettlement(
      data,
      event.funding_time,
      this.fundingSettlement.detection_window_seconds
    )

    const applyFunding = shouldApplyFunding({
      entryTs,
      exitTs: exit.ts,
      fundingTs: settlement.settlementTs,
      fundingAppliedOnSameSecond: this.config.funding_applied_on_same_second,
    })

    const pnl = calculatePnl({
      direction: 'long',
      entryPrice: entryFill.price,
      exitPrice: exit.price,
      fundingRate: event.funding_rate,
      appliedFraction: fundingFraction(applyFunding),
      entryFeeType: 'taker',
      exitFeeType: exit.feeType,
      feeSchedule: this.feeSchedule,
    })

    const exitTime = new Date(exit.ts.replace(' ', 'T') + 'Z')
    const holdDuration = (exitTime.getTime() - entryTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: event.exchange,
      symbol: event.symbol,
      funding_time: event.funding_time,
      funding_rate: event.funding_rate,
      entry_price: entryFill.price,
      exit_price: exit.price,
      pnl,
      exit_reason: exit.reason,
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: applyFunding,
      real_settlement_ts: settlement.settlementTs,
      real_settlement_detected: settlement.detected,
      real_settlement_drop: settlement.dropMagnitude,
    }
  }
}
