import type { FeeSchedule, Strategy43Config } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { simulateOrders } from '../orders/simulator.js'
import { checkLimitFill } from '../orders/limit-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'
import type { ExitReason } from '../config/schema.js'
import type { Order } from '../orders/types.js'

/**
 * Strategy 4.3: Negative Funding LONG - Limit Entry with SL/TP
 *
 * Limit entry at T_funding - 2s. SL and TP placed after fill.
 * Tighter entry with explicit stop-loss.
 */
export class Strategy43 implements BaseStrategy {
  readonly id: string
  private config!: Strategy43Config
  private feeSchedule!: FeeSchedule
  private slippage = 0

  constructor(variant: 'strategy_4_3a' | 'strategy_4_3b') {
    this.id = variant
  }

  initialize(config: Strategy43Config, feeSchedule: FeeSchedule, slippage: number): void {
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate < 0 && Math.abs(event.funding_rate) >= this.config.funding_threshold
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | null {
    const absF = Math.abs(event.funding_rate)
    const entrySetupTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)

    const setupTs = toClickHouseDateTime(entrySetupTime)
    const deadlineTs = toClickHouseDateTime(deadlineTime)

    const setupCandle = data.getRowAt(setupTs)
    if (setupCandle?.ask_open == null) return null
    const pCurrent = setupCandle.ask_open

    // Limit entry price
    const limitPrice = pCurrent * (1 - absF * this.config.entry_mult)
    // SL price
    const slPrice = pCurrent * (1 - absF * this.config.sl_mult)

    // Check if limit entry fills in window
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

    // TP price based on fill price
    const tpPrice = entryFill.price * (1 + this.config.take_profit)

    // Get candles after entry for SL/TP simulation
    const postEntryRows = windowRows.slice(entryIdx + 1)

    if (postEntryRows.length === 0) {
      // No candles after entry — deadline at entry
      return null
    }

    const lastPostRow = postEntryRows[postEntryRows.length - 1]
    const firstPostRow = postEntryRows[0]
    if (!lastPostRow || !firstPostRow) return null
    const lastPostTs = lastPostRow.ts

    // Create SL and TP orders
    const orders: Order[] = [
      {
        side: 'sell',
        type: 'stop',
        price: slPrice,
        quantity: 1,
        validFrom: firstPostRow.ts,
        validUntil: lastPostTs,
        reduceOnly: true,
        label: 'sl',
      },
      {
        side: 'sell',
        type: 'limit',
        price: tpPrice,
        quantity: 1,
        validFrom: firstPostRow.ts,
        validUntil: lastPostTs,
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const { fills } = simulateOrders(orders, postEntryRows, this.slippage, 'long')

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string }

    const slFill = fills.find(f => f.label === 'sl')
    const tpFill = fills.find(f => f.label === 'tp')

    if (slFill) {
      exit = { price: slFill.price, reason: 'SL_HIT', feeType: 'taker', ts: slFill.timestamp }
    } else if (tpFill) {
      exit = { price: tpFill.price, reason: 'TP_HIT', feeType: 'maker', ts: tpFill.timestamp }
    } else {
      // Deadline exit
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFillResult = fillMarketOrder('sell', deadlineCandle, 1, 'deadline')
        if (!deadlineFillResult) return null
        exit = { price: deadlineFillResult.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      } else {
        const lastFillResult = fillMarketOrder('sell', lastPostRow, 1, 'deadline')
        if (!lastFillResult) return null
        exit = { price: lastFillResult.price, reason: 'DEADLINE', feeType: 'taker', ts: deadlineTs }
      }
    }

    const pnl = calculatePnl({
      direction: 'long',
      entryPrice: entryFill.price,
      exitPrice: exit.price,
      fundingRate: event.funding_rate,
      includeFunding: this.config.include_funding,
      entryFeeType: 'maker', // Limit entry
      exitFeeType: exit.feeType,
      feeSchedule: this.feeSchedule,
    })

    const exitTime = new Date(exit.ts.replace(' ', 'T') + 'Z')
    const holdDuration = (exitTime.getTime() - entrySetupTime.getTime()) / 1000

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
      funding_received: this.config.include_funding,
    }
  }
}
