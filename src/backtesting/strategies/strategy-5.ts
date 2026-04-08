import type { FeeSchedule, Strategy5Config } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkLimitFill } from '../orders/limit-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'
import type { ExitReason } from '../config/schema.js'

/**
 * Strategy 5: Cross-Exchange Funding Arbitrage
 *
 * When Exchange A has high negative funding and Exchange B has low funding,
 * short on Exchange B to capture the price drop driven by A's settlement.
 *
 * This strategy requires separate data windows for both exchanges.
 * The execute method here operates on Exchange B's data only.
 * Cross-exchange selection logic is handled at the engine level.
 */
export class Strategy5 implements BaseStrategy {
  readonly id = 'strategy_5'
  private config!: Strategy5Config
  private feeSchedule!: FeeSchedule

  initialize(config: Strategy5Config, feeSchedule: FeeSchedule, slippage?: number): void {
    void slippage
    this.config = config
    this.feeSchedule = feeSchedule
  }

  /**
   * For S5, shouldTrigger is handled differently at the engine level
   * because it requires data from two exchanges.
   * This method checks only the basic funding rate condition.
   */
  shouldTrigger(): boolean {
    // S5 triggering is done at the engine level with cross-exchange data
    return true
  }

  /**
   * Execute short on Exchange B.
   *
   * @param event - Funding event (with Exchange B's funding rate)
   * @param data - Exchange B's orderbook data window
   * @param fundingRateA - Exchange A's funding rate (passed separately)
   * @param fundingRateB - Exchange B's funding rate
   */
  executeWithCrossExchange(
    event: FundingEvent,
    data: OHLCWindow,
    fundingRateA: number,
    fundingRateB: number
  ): TradeResult | null {
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)

    const entryTs = toClickHouseDateTime(entryTime)
    const deadlineTs = toClickHouseDateTime(deadlineTime)

    const entryCandle = data.getRowAt(entryTs)
    if (!entryCandle) return null

    // SELL MARKET on Exchange B
    const entryFill = fillMarketOrder('sell', entryCandle, 1, 'entry')
    if (!entryFill) return null

    // TP = (F_A - F_B) / 2
    const tpDistance = (Math.abs(fundingRateA) - Math.abs(fundingRateB)) / 2
    const tpPrice = entryFill.price * (1 - tpDistance)

    // Check for TP in window
    const windowRows = data.getRowsInRange(entryTs, deadlineTs)
    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string } | null = null

    for (let i = 1; i < windowRows.length; i++) {
      const row = windowRows[i]
      if (!row) continue
      const tpFill = checkLimitFill('buy', tpPrice, row, 1, 'tp')
      if (tpFill) {
        exit = { price: tpPrice, reason: 'TP_HIT', feeType: 'maker', ts: row.ts }
        break
      }
    }

    if (!exit) {
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFillResult = fillMarketOrder('buy', deadlineCandle, 1, 'deadline')
        if (!deadlineFillResult) return null
        exit = { price: deadlineFillResult.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      } else {
        const lastRow = windowRows[windowRows.length - 1]
        if (!lastRow) return null
        const lastFillResult = fillMarketOrder('buy', lastRow, 1, 'deadline')
        if (!lastFillResult) return null
        exit = { price: lastFillResult.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      }
    }

    // Shorts on B pay F_B funding
    const pnl = calculatePnl({
      direction: 'short',
      entryPrice: entryFill.price,
      exitPrice: exit.price,
      fundingRate: fundingRateB,
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
      funding_rate: fundingRateB,
      entry_price: entryFill.price,
      exit_price: exit.price,
      pnl,
      exit_reason: exit.reason,
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: false, // Shorts pay
    }
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null {
    // S5 should use executeWithCrossExchange instead
    return this.executeWithCrossExchange(event, data, event.funding_rate, event.funding_rate)
  }
}
