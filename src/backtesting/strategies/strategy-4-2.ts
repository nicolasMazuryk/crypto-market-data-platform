import type { FeeSchedule, Strategy42Config } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkLimitFill } from '../orders/limit-order.js'
import { simulateOrders } from '../orders/simulator.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'
import type { ExitReason } from '../config/schema.js'
import type { Order } from '../orders/types.js'

/**
 * Strategy 4.2: Negative Funding Single LONG - Post-Funding Entry
 *
 * Single limit buy at P_current * (1 - F * limit_offset_mult).
 * Exit at SL (below entry), TP (above entry), or deadline.
 */
export class Strategy42 implements BaseStrategy {
  readonly id: string
  private config!: Strategy42Config
  private feeSchedule!: FeeSchedule
  private slippage = 0

  constructor(variant: 'strategy_4_2a' | 'strategy_4_2b') {
    this.id = variant
  }

  initialize(config: Strategy42Config, feeSchedule: FeeSchedule, slippage: number): void {
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate < 0 && Math.abs(event.funding_rate) >= this.config.funding_threshold
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null {
    const absF = Math.abs(event.funding_rate)
    const setupTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)

    const setupTs = toClickHouseDateTime(setupTime)
    const deadlineTs = toClickHouseDateTime(deadlineTime)
    const fundingTs = toClickHouseDateTime(event.funding_time)

    const setupCandle = data.getRowAt(setupTs)
    if (setupCandle?.ask_open == null) return null
    const pCurrent = setupCandle.ask_open

    const limitPrice = pCurrent * (1 - absF * this.config.limit_offset_mult)

    const windowRows = data.getRowsInRange(setupTs, deadlineTs)
    if (windowRows.length === 0) return null

    let entryFill = null
    let entryIdx = -1
    for (let i = 0; i < windowRows.length; i++) {
      const row = windowRows[i]
      if (!row) continue
      const fill = checkLimitFill('buy', limitPrice, row, 1, 'entry')
      if (fill) {
        entryFill = fill
        entryIdx = i
        break
      }
    }

    if (!entryFill || entryIdx === -1) return null

    const slPrice = entryFill.price * (1 - absF * this.config.sl_mult)
    const tpPrice = entryFill.price * (1 + this.config.take_profit)

    const postEntryRows = windowRows.slice(entryIdx + 1)

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string } | null = null

    if (postEntryRows.length > 0) {
      const firstPostRow = postEntryRows[0]
      if (!firstPostRow) return null

      const orders: Order[] = [
        {
          side: 'sell',
          type: 'stop',
          price: slPrice,
          quantity: 1,
          validFrom: firstPostRow.ts,
          validUntil: deadlineTs,
          reduceOnly: true,
          label: 'sl',
        },
        {
          side: 'sell',
          type: 'limit',
          price: tpPrice,
          quantity: 1,
          validFrom: firstPostRow.ts,
          validUntil: deadlineTs,
          reduceOnly: true,
          label: 'tp',
        },
      ]

      const { fills } = simulateOrders(orders, postEntryRows, this.slippage, 'long')

      const slFill = fills.find(f => f.label === 'sl')
      const tpFill = fills.find(f => f.label === 'tp')

      if (slFill) {
        exit = { price: slFill.price, reason: 'SL_HIT', feeType: 'taker', ts: slFill.timestamp }
      } else if (tpFill) {
        exit = { price: tpFill.price, reason: 'TP_HIT', feeType: 'maker', ts: tpFill.timestamp }
      }
    }

    if (!exit) {
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFillResult = fillMarketOrder('sell', deadlineCandle, 1, 'deadline')
        if (!deadlineFillResult) return null
        exit = { price: deadlineFillResult.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      } else {
        const lastRow = windowRows[windowRows.length - 1]
        if (!lastRow) return null
        const lastFillResult = fillMarketOrder('sell', lastRow, 1, 'deadline')
        if (!lastFillResult) return null
        exit = { price: lastFillResult.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      }
    }

    const applyFunding = shouldApplyFunding({
      entryTs: entryFill.timestamp,
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
      entryFeeType: 'maker',
      exitFeeType: exit.feeType,
      feeSchedule: this.feeSchedule,
    })

    const entryTime = new Date(entryFill.timestamp.replace(' ', 'T') + 'Z')
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
