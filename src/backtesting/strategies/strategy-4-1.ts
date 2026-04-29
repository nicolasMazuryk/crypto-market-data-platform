import type { FeeSchedule, Strategy41Config } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { simulateLadderOrders, simulateOrders } from '../orders/simulator.js'
import { calculateLadderPnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'
import type { ExitReason } from '../config/schema.js'
import type { Order } from '../orders/types.js'

/**
 * Strategy 4.1: Negative Funding Ladder LONG - Post-Funding Entry
 *
 * Place a ladder of limit buy orders below current price to catch the post-funding drop.
 * Exit at SL (below P_avg) or TP (above P_avg) or deadline.
 * Funding fee: a (excluded) or b (included), controlled by config.
 */
export class Strategy41 implements BaseStrategy {
  readonly id: string
  private config!: Strategy41Config
  private feeSchedule!: FeeSchedule
  private slippage = 0

  constructor(variant: 'strategy_4_1a' | 'strategy_4_1b') {
    this.id = variant
  }

  initialize(config: Strategy41Config, feeSchedule: FeeSchedule, slippage: number): void {
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

    // Record P_current from ask price at setup time
    const setupCandle = data.getRowAt(setupTs)
    if (setupCandle?.ask_open == null) return null
    const pCurrent = setupCandle.ask_open

    // Compute ladder range
    const ladderTop = pCurrent * (1 - absF * this.config.ladder_top_mult)
    const ladderBottom = pCurrent * (1 - absF * this.config.ladder_bottom_mult)

    // Create ladder orders
    const ladderOrders: Order[] = []
    const count = this.config.ladder_count
    for (let i = 0; i < count; i++) {
      const price = count === 1 ? ladderTop : ladderTop - (i * (ladderTop - ladderBottom)) / (count - 1)
      ladderOrders.push({
        side: 'buy',
        type: 'limit',
        price,
        quantity: 1 / count,
        validFrom: setupTs,
        validUntil: deadlineTs,
        reduceOnly: false,
        label: `ladder_${String(i)}`,
      })
    }

    // Get candles for the fill window
    const windowRows = data.getRowsInRange(setupTs, deadlineTs)
    if (windowRows.length === 0) return null

    // Simulate ladder fills
    const { fills } = simulateLadderOrders(ladderOrders, windowRows)

    if (fills.length === 0) return null

    // Compute P_avg (weighted average of filled prices)
    let totalQtyPrice = 0
    let totalQty = 0
    for (const fill of fills) {
      totalQtyPrice += fill.price * fill.quantity
      totalQty += fill.quantity
    }
    const pAvg = totalQtyPrice / totalQty

    // SL and TP anchored to P_avg
    const slPrice = pAvg * (1 - absF * this.config.sl_mult)
    const tpPrice = pAvg * (1 + this.config.take_profit)

    // Find last fill timestamp
    const firstFill = fills[0]
    if (!firstFill) return null
    let lastFillTs = firstFill.timestamp
    for (const fill of fills) {
      if (fill.timestamp > lastFillTs) lastFillTs = fill.timestamp
    }

    // Get candles after last fill for SL/TP simulation (skip fill candle itself)
    const postFillRows = data.getRowsInRange(lastFillTs, deadlineTs)
    const postFillSliced = postFillRows.slice(1)

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string } | null = null

    if (postFillSliced.length > 0) {
      const firstPostFillRow = postFillSliced[0]
      if (!firstPostFillRow) return null

      const orders: Order[] = [
        {
          side: 'sell',
          type: 'stop',
          price: slPrice,
          quantity: totalQty,
          validFrom: firstPostFillRow.ts,
          validUntil: deadlineTs,
          reduceOnly: true,
          label: 'sl',
        },
        {
          side: 'sell',
          type: 'limit',
          price: tpPrice,
          quantity: totalQty,
          validFrom: firstPostFillRow.ts,
          validUntil: deadlineTs,
          reduceOnly: true,
          label: 'tp',
        },
      ]

      const { fills: exitFills } = simulateOrders(orders, postFillSliced, this.slippage, 'long')

      const slFill = exitFills.find(f => f.label === 'sl')
      const tpFill = exitFills.find(f => f.label === 'tp')

      if (slFill) {
        exit = { price: slFill.price, reason: 'SL_HIT', feeType: 'taker', ts: slFill.timestamp }
      } else if (tpFill) {
        exit = { price: tpFill.price, reason: 'TP_HIT', feeType: 'maker', ts: tpFill.timestamp }
      }
    }

    if (!exit) {
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFill = fillMarketOrder('sell', deadlineCandle, totalQty, 'deadline')
        if (!deadlineFill) return null
        exit = { price: deadlineFill.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      } else {
        const lastRow = windowRows[windowRows.length - 1]
        if (!lastRow) return null
        const lastFill = fillMarketOrder('sell', lastRow, totalQty, 'deadline')
        if (!lastFill) return null
        exit = { price: lastFill.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      }
    }

    const pnl = calculateLadderPnl({
      direction: 'long',
      avgEntryPrice: pAvg,
      exitPrice: exit.price,
      fundingRate: event.funding_rate,
      includeFunding: this.config.include_funding,
      numFilled: fills.length,
      exitFeeType: exit.feeType,
      feeSchedule: this.feeSchedule,
    })

    const exitTime = new Date(exit.ts.replace(' ', 'T') + 'Z')
    const holdDuration = (exitTime.getTime() - setupTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: event.exchange,
      symbol: event.symbol,
      funding_time: event.funding_time,
      funding_rate: event.funding_rate,
      entry_price: pAvg,
      exit_price: exit.price,
      pnl,
      exit_reason: exit.reason,
      hold_duration: holdDuration,
      fill_count: fills.length,
      funding_received: this.config.include_funding,
    }
  }
}
