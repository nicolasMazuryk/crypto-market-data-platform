import type { FeeSchedule, Strategy2Config } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { simulateOrders } from '../orders/simulator.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'
import type { ExitReason } from '../config/schema.js'
import type { Order } from '../orders/types.js'

/**
 * Strategy 2: Negative Funding LONG - Retracement Exit
 *
 * Enter LONG at T_funding - entry_offset. After the drop, wait for a partial
 * retracement. Exit at retracement target, stop-loss, or deadline.
 * SL is active from entry+1s; TP only valid after T_low is identified.
 */
export class Strategy2 implements BaseStrategy {
  readonly id = 'strategy_2'
  private config!: Strategy2Config
  private feeSchedule!: FeeSchedule
  private slippage = 0

  initialize(config: Strategy2Config, feeSchedule: FeeSchedule, slippage: number): void {
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
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

    // SL anchored to entry price
    const slPrice = entryFill.price * (1 - absF * this.config.sl_mult)

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

    // Retracement target (TP) — only valid after T_low
    const pTarget = pLow + (pFunding - pLow) * this.config.retracement_pct

    // T_low + 1s: TP only active after T_low is identified
    const tLowRow = postFundingRows[tLowIdx]
    if (!tLowRow) return null
    const tLowPlus1Ts = toClickHouseDateTime(new Date(new Date(tLowRow.ts.replace(' ', 'T') + 'Z').getTime() + 1000))

    // Simulate SL+TP over [entry+1s, deadline]
    const entryPlus1Ts = toClickHouseDateTime(new Date(entryTime.getTime() + 1000))
    const allPostEntryRows = data.getRowsInRange(entryPlus1Ts, deadlineTs)
    if (allPostEntryRows.length === 0) return null

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'stop',
        price: slPrice,
        quantity: 1,
        validFrom: entryPlus1Ts,
        validUntil: deadlineTs,
        reduceOnly: true,
        label: 'sl',
      },
      {
        side: 'sell',
        type: 'limit',
        price: pTarget,
        quantity: 1,
        validFrom: tLowPlus1Ts,
        validUntil: deadlineTs,
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const { fills } = simulateOrders(orders, allPostEntryRows, this.slippage, 'long')

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string }

    const slFill = fills.find(f => f.label === 'sl')
    const tpFill = fills.find(f => f.label === 'tp')

    if (slFill) {
      exit = { price: slFill.price, reason: 'SL_HIT', feeType: 'taker', ts: slFill.timestamp }
    } else if (tpFill) {
      exit = { price: tpFill.price, reason: 'TP_HIT', feeType: 'maker', ts: tpFill.timestamp }
    } else {
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

    const applyFunding = shouldApplyFunding({
      entryTs,
      exitTs: exit.ts,
      fundingTs,
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
    }
  }
}
