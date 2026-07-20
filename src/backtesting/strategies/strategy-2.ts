import type { FeeSchedule, Strategy2Config, FundingSettlementConfig } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import type { OrderbookRow } from '../../db/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkLimitFill } from '../orders/limit-order.js'
import { checkStopFill } from '../orders/stop-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult, LookaheadContext } from './types.js'
import type { ExitReason } from '../config/schema.js'

/**
 * Strategy 2: Negative Funding LONG - Retracement Exit
 *
 * Enter LONG at T_funding - entry_offset. After the drop, wait for a partial
 * retracement. Exit at retracement target, stop-loss, or deadline.
 * SL is active from entry+1s; TP only valid after max(T_low+1s, T_drop+buffer).
 *
 * T_drop is localized by the engine (§3.1) and passed via the lookahead context. The forward
 * loop advances the time gate per candle, so any post-decision non-localization read of future
 * data throws a LookaheadViolationError.
 */
export class Strategy2 implements BaseStrategy {
  readonly id = 'strategy_2'
  private config!: Strategy2Config
  private feeSchedule!: FeeSchedule
  private slippage = 0
  private fundingSettlement: FundingSettlementConfig = {
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
    return event.funding_rate * 100 <= -Math.abs(this.config.negative_funding_threshold_percent)
  }

  execute(event: FundingEvent, _data: OHLCWindow, context?: LookaheadContext): TradeResult | null {
    void _data
    if (!context) throw new Error('strategy_2 requires a LookaheadContext')
    const { gated, tDropTs, noDropLocalized } = context

    const absF = Math.abs(event.funding_rate)
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)

    const entryTs = toClickHouseDateTime(entryTime)
    const fundingTs = toClickHouseDateTime(event.funding_time)
    const deadlineTs = toClickHouseDateTime(deadlineTime)

    gated.advanceTo(entryTs)
    const entryCandle = gated.getRowAt(entryTs)
    if (!entryCandle) return null

    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry')
    if (!entryFill) return null

    const slPrice = entryFill.price * (1 - absF * this.config.sl_multiplier)

    // P_funding is the reference price at T_settle; the engine anchors the drop search here.
    gated.advanceTo(fundingTs)
    const fundingCandle = gated.getRowAt(fundingTs)
    if (fundingCandle?.bid_open == null) return null
    const pFunding = fundingCandle.bid_open

    // TP cannot become valid until max(T_low+1s, T_drop + buffer).
    const settlementEpochMs =
      new Date(tDropTs.replace(' ', 'T') + 'Z').getTime() +
      this.fundingSettlement.tp_post_settlement_buffer_seconds * 1000

    // Simulate SL + dynamic TP online, advancing the gate one candle at a time. P_low is learned
    // only from candles already seen after funding; the repriced TP becomes active on the
    // following timestamp.
    const entryMs = entryTime.getTime()
    const deadlineMs = deadlineTime.getTime()

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string } | undefined
    let pLow = Infinity
    let activeTpPrice: number | undefined
    let activeTpFrom: string | undefined
    let seenAny = false
    let lastRow: OrderbookRow | undefined

    for (let sec = 1; entryMs + sec * 1000 <= deadlineMs; sec++) {
      const rowTs = toClickHouseDateTime(new Date(entryMs + sec * 1000))
      if (rowTs > gated.getCurrentTime()) gated.advanceTo(rowTs)
      const row = gated.getRowAt(rowTs)
      if (!row) continue
      seenAny = true
      lastRow = row

      const slFill = checkStopFill('sell', slPrice, row, 1, this.slippage, 'sl')
      const tpFill =
        activeTpPrice !== undefined && activeTpFrom !== undefined && row.ts >= activeTpFrom
          ? checkLimitFill('sell', activeTpPrice, row, 1, 'tp')
          : null

      // Same-candle ambiguity is intentionally conservative: SL wins.
      if (slFill) {
        exit = { price: slFill.price, reason: 'sl_hit', feeType: 'taker', ts: slFill.timestamp }
        break
      }
      if (tpFill) {
        exit = { price: tpFill.price, reason: 'tp_hit', feeType: 'maker', ts: tpFill.timestamp }
        break
      }

      if (row.ts >= fundingTs && row.ts <= deadlineTs && row.bid_low !== null && row.bid_low < pLow) {
        pLow = row.bid_low
        if (pFunding > pLow) {
          activeTpPrice = pLow + (pFunding - pLow) * this.config.retracement_pct
          activeTpFrom = toClickHouseDateTime(
            new Date(Math.max(new Date(row.ts.replace(' ', 'T') + 'Z').getTime() + 1000, settlementEpochMs))
          )
        }
      }
    }

    if (!seenAny) return null

    if (exit === undefined) {
      const deadlineCandle = gated.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFill = fillMarketOrder('sell', deadlineCandle, 1, 'deadline')
        if (!deadlineFill) return null
        exit = { price: deadlineFill.price, reason: 'deadline', feeType: 'taker', ts: deadlineTs }
      } else {
        if (!lastRow) return null
        const lastFill = fillMarketOrder('sell', lastRow, 1, 'deadline')
        if (!lastFill) return null
        exit = { price: lastFill.price, reason: 'deadline', feeType: 'taker', ts: deadlineTs }
      }
    }

    const applyFunding = shouldApplyFunding({
      entryTs,
      exitTs: exit.ts,
      fundingTs: tDropTs,
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
      real_settlement_ts: tDropTs,
      real_settlement_detected: !noDropLocalized,
    }
  }
}
