import type { FeeSchedule, Strategy5Config } from '../config/schema.js'
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
 * Strategy 5: Main-Exchange-Driven Cross-Exchange Short
 *
 * When the main (most-liquid) exchange has deeply negative funding, short on
 * a less-negative target exchange to capture the price drop while paying
 * smaller funding cost.
 *
 * Cross-exchange selection and data fetching are handled at the engine level.
 * executeMainExchange operates on the target exchange's data.
 */
export class Strategy5 implements BaseStrategy {
  readonly id = 'strategy_5'
  private config!: Strategy5Config
  private slippage = 0

  initialize(config: Strategy5Config, _feeSchedule: FeeSchedule, slippage?: number): void {
    this.config = config
    this.slippage = slippage ?? 0
  }

  shouldTrigger(): boolean {
    return true
  }

  /**
   * Execute short on target exchange.
   *
   * Entry and deadline are anchored to `event.funding_time` (main exchange's trigger time).
   * Funding applicability uses `targetFundingTime` (target's actual funding tick).
   *
   * @param event - Contains exchange=target, funding_time=MAIN's time (trigger), funding_rate=target's rate
   * @param data - Target exchange's orderbook data window
   * @param mainFundingRate - Main exchange's funding rate (negative, triggers setup)
   * @param targetFundingRate - Target exchange's funding rate (signed; short pays this)
   * @param targetFundingTime - Target exchange's actual funding time (for funding applicability check)
   * @param feeSchedule - Target exchange's fee schedule
   */
  executeMainExchange(
    event: FundingEvent,
    data: OHLCWindow,
    mainFundingRate: number,
    targetFundingRate: number,
    targetFundingTime: Date,
    feeSchedule: FeeSchedule
  ): TradeResult | null {
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const entryTs = toClickHouseDateTime(entryTime)
    // Use target's actual funding time so applicability is correct when exchanges are offset
    const fundingTs = toClickHouseDateTime(targetFundingTime)

    const entryCandle = data.getRowAt(entryTs)
    if (!entryCandle) return null

    const entryFill = fillMarketOrder('sell', entryCandle, 1, 'entry')
    if (!entryFill) return null

    const entryPrice = entryFill.price
    const tpDistance = Math.abs(mainFundingRate) * this.config.tp_multiplier
    const tpPrice = entryPrice * (1 - tpDistance)
    const slPrice = entryPrice * (1 + this.config.stop_loss)

    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)
    const deadlineTs = toClickHouseDateTime(deadlineTime)
    const postEntryRows = data.getRowsInRange(entryTs, deadlineTs)
    const orderCandles = postEntryRows.slice(1)

    if (orderCandles.length === 0) return null

    const lastOrderCandle = orderCandles[orderCandles.length - 1]
    const firstOrderCandle = orderCandles[0]
    if (!lastOrderCandle || !firstOrderCandle) return null
    const validUntil = lastOrderCandle.ts

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
      fundingRate: targetFundingRate,
      appliedFraction: fundingFraction(applyFunding),
      entryFeeType: 'taker',
      exitFeeType,
      feeSchedule,
    })

    const exitTime = new Date(exitTs.replace(' ', 'T') + 'Z')
    const holdDuration = (exitTime.getTime() - entryTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: event.exchange,
      symbol: event.symbol,
      funding_time: event.funding_time,
      funding_rate: targetFundingRate,
      entry_price: entryPrice,
      exit_price: exitPrice,
      pnl,
      exit_reason: exitReason,
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: applyFunding,
    }
  }

  execute(_event: FundingEvent, _data: OHLCWindow): TradeResult | null {
    // S5 execution goes through executeMainExchange with per-trade fee schedule
    return null
  }
}
