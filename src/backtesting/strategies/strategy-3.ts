import type { FeeSchedule, Strategy3Config } from '../config/schema.js'
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
 * Strategy 3: Negative Funding SHORT - Ride the Drop
 *
 * SELL MARKET at T_funding - entry_offset. Place SL and TP.
 * Two TP variants: A = F * 1.5, B = F + 0.4%
 * Shorts PAY funding.
 */
export class Strategy3 implements BaseStrategy {
  readonly id: string
  private config!: Strategy3Config
  private feeSchedule!: FeeSchedule
  private slippage = 0

  constructor(variant: 'strategy_3a') {
    this.id = variant
  }

  initialize(config: Strategy3Config, feeSchedule: FeeSchedule, slippage: number): void {
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
    const entryTs = toClickHouseDateTime(entryTime)
    const fundingTs = toClickHouseDateTime(event.funding_time)

    const entryCandle = data.getRowAt(entryTs)
    if (!entryCandle) return null

    // SELL MARKET at entry (fills at bid_open)
    const entryFill = fillMarketOrder('sell', entryCandle, 1, 'entry')
    if (!entryFill) return null

    const entryPrice = entryFill.price

    // Compute TP based on mode
    let tpDistance: number
    if (this.config.tp_mode === 'A') {
      tpDistance = absF * this.config.tp_multiplier
    } else {
      tpDistance = absF + this.config.tp_addend_pct / 100
    }

    const tpPrice = entryPrice * (1 - tpDistance)
    const slPrice = entryPrice * (1 + this.config.stop_loss)

    // Get candles after entry up to deadline
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)
    const deadlineTs = toClickHouseDateTime(deadlineTime)
    const postEntryRows = data.getRowsInRange(entryTs, deadlineTs)
    // Remove entry candle (orders placed IMMEDIATELY after entry)
    const orderCandles = postEntryRows.slice(1)

    if (orderCandles.length === 0) return null

    const lastOrderCandle = orderCandles[orderCandles.length - 1]
    const firstOrderCandle = orderCandles[0]
    if (!lastOrderCandle || !firstOrderCandle) return null
    const validUntil = lastOrderCandle.ts

    // Create SL and TP orders
    const orders: Order[] = [
      {
        side: 'buy',
        type: 'stop',
        price: slPrice,
        quantity: 1,
        validFrom: firstOrderCandle.ts,
        validUntil,
        reduceOnly: true,
        label: 'sl',
      },
      {
        side: 'buy',
        type: 'limit',
        price: tpPrice,
        quantity: 1,
        validFrom: firstOrderCandle.ts,
        validUntil,
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const { fills } = simulateOrders(orders, orderCandles, this.slippage, 'short')

    let exitPrice: number
    let exitReason: ExitReason
    let exitFeeType: 'maker' | 'taker'
    let exitTs: string

    const slFill = fills.find(f => f.label === 'sl')
    const tpFill = fills.find(f => f.label === 'tp')

    if (slFill) {
      exitPrice = slFill.price
      exitReason = 'SL_HIT'
      exitFeeType = 'taker'
      exitTs = slFill.timestamp
    } else if (tpFill) {
      exitPrice = tpFill.price
      exitReason = 'TP_HIT'
      exitFeeType = 'maker'
      exitTs = tpFill.timestamp
    } else {
      // Deadline exit — market buy to close short
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFillResult = fillMarketOrder('buy', deadlineCandle, 1, 'deadline')
        if (!deadlineFillResult) return null
        exitPrice = deadlineFillResult.price
        exitReason = 'DEADLINE'
        exitFeeType = 'taker'
        exitTs = deadlineTs
      } else {
        const lastFillResult = fillMarketOrder('buy', lastOrderCandle, 1, 'deadline')
        if (!lastFillResult) return null
        exitPrice = lastFillResult.price
        exitReason = 'DEADLINE'
        exitFeeType = 'taker'
        exitTs = deadlineTs
      }
    }

    const applyFunding = shouldApplyFunding({
      entryTs,
      exitTs,
      fundingTs,
      fundingAppliedOnSameSecond: this.config.funding_applied_on_same_second,
    })

    const pnl = calculatePnl({
      direction: 'short',
      entryPrice,
      exitPrice,
      fundingRate: event.funding_rate,
      appliedFraction: fundingFraction(applyFunding),
      entryFeeType: 'taker',
      exitFeeType,
      feeSchedule: this.feeSchedule,
    })

    const exitTime = new Date(exitTs.replace(' ', 'T') + 'Z')
    const holdDuration = (exitTime.getTime() - entryTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: event.exchange,
      symbol: event.symbol,
      funding_time: event.funding_time,
      funding_rate: event.funding_rate,
      entry_price: entryPrice,
      exit_price: exitPrice,
      pnl,
      exit_reason: exitReason,
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: applyFunding,
    }
  }
}
