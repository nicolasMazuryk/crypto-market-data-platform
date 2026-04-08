import type { FeeSchedule, Strategy2Config } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkLimitFill } from '../orders/limit-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'
import type { ExitReason } from '../config/schema.js'

/**
 * Strategy 2: Negative Funding LONG - Retracement Exit
 *
 * Enter LONG at T_funding - entry_offset. After the drop, wait for a partial
 * retracement. Exit at retracement target or at deadline.
 */
export class Strategy2 implements BaseStrategy {
  readonly id = 'strategy_2'
  private config!: Strategy2Config
  private feeSchedule!: FeeSchedule

  initialize(config: Strategy2Config, feeSchedule: FeeSchedule, slippage?: number): void {
    void slippage
    this.config = config
    this.feeSchedule = feeSchedule
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate < 0 && Math.abs(event.funding_rate) >= this.config.funding_threshold
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null {
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)

    const entryTs = toClickHouseDateTime(entryTime)
    const fundingTs = toClickHouseDateTime(event.funding_time)
    const deadlineTs = toClickHouseDateTime(deadlineTime)

    const entryCandle = data.getRowAt(entryTs)
    if (!entryCandle) return null

    // BUY MARKET at entry
    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry')
    if (!entryFill) return null

    // Get P_funding (price at funding time)
    const fundingCandle = data.getRowAt(fundingTs)
    if (fundingCandle?.bid_open == null) return null
    const pFunding = fundingCandle.bid_open

    // Find P_low in [T_funding, T_deadline]
    const postFundingRows = data.getRowsInRange(fundingTs, deadlineTs)
    if (postFundingRows.length === 0) return null

    let pLow = Infinity
    let tLowIdx = 0
    for (let i = 0; i < postFundingRows.length; i++) {
      const row = postFundingRows[i]
      if (row && row.bid_low !== null && row.bid_low < pLow) {
        pLow = row.bid_low
        tLowIdx = i
      }
    }

    if (pLow === Infinity) return null

    // Compute retracement target
    const pTarget = pLow + (pFunding - pLow) * this.config.retracement_pct

    // Check if price reaches P_target AFTER T_low and BEFORE T_deadline
    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string } | null = null

    // Search for retracement fill AFTER T_low
    for (let i = tLowIdx + 1; i < postFundingRows.length; i++) {
      const row = postFundingRows[i]
      if (!row) continue
      const fill = checkLimitFill('sell', pTarget, row, 1, 'tp')
      if (fill) {
        exit = { price: pTarget, reason: 'TP_HIT', feeType: 'maker', ts: row.ts }
        break
      }
    }

    if (!exit) {
      // Deadline exit
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (!deadlineCandle) {
        // Use last available candle
        const lastRow = postFundingRows[postFundingRows.length - 1]
        if (!lastRow) return null
        const deadlineFill = fillMarketOrder('sell', lastRow, 1, 'deadline')
        if (!deadlineFill) return null
        exit = { price: deadlineFill.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      } else {
        const deadlineFill = fillMarketOrder('sell', deadlineCandle, 1, 'deadline')
        if (!deadlineFill) return null
        exit = { price: deadlineFill.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      }
    }

    const pnl = calculatePnl({
      direction: 'long',
      entryPrice: entryFill.price,
      exitPrice: exit.price,
      fundingRate: event.funding_rate,
      includeFunding: true,
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
      funding_received: true,
    }
  }
}
