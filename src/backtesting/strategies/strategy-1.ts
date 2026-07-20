import type { FeeSchedule, Strategy1Config, FundingSettlementConfig } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { toClickHouseDateTime } from '../../db/types.js'
import { applyOrderLatency } from '../engine/latency.js'
import type { BaseStrategy, TradeResult, LookaheadContext } from './types.js'

/**
 * Strategy 1: Negative Funding LONG - Instant Exit
 *
 * Enter LONG at T_funding - entry_offset, exit at T_drop + exit_offset. The engine localizes
 * T_drop (§3.1) and hands it in via the lookahead context; the strategy reads its entry/exit
 * candles through the gated window, advancing the gate forward as it goes.
 */
export class Strategy1 implements BaseStrategy {
  readonly id = 'strategy_1'
  private config!: Strategy1Config
  private feeSchedule!: FeeSchedule
  private slippage = 0
  private orderLatencyMs!: number

  initialize(
    config: Strategy1Config,
    feeSchedule: FeeSchedule,
    slippage: number,
    orderLatencyMs: number,
    fundingSettlement?: FundingSettlementConfig
  ): void {
    void fundingSettlement
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
    this.orderLatencyMs = orderLatencyMs
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate * 100 <= -Math.abs(this.config.negative_funding_threshold_percent)
  }

  execute(event: FundingEvent, _data: OHLCWindow, context?: LookaheadContext): TradeResult | null {
    void _data
    if (!context) throw new Error('strategy_1 requires a LookaheadContext')
    const { gated, tDropTs, noDropLocalized } = context

    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const entryDecisionTs = toClickHouseDateTime(entryTime)
    const entryTs = applyOrderLatency(entryDecisionTs, this.orderLatencyMs)

    gated.advanceTo(entryTs)
    const entryCandle = gated.getRowAt(entryTs)
    if (!entryCandle) return null

    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry', this.slippage)
    if (!entryFill) return null

    const settlementTime = new Date(tDropTs.replace(' ', 'T') + 'Z')
    const exitTime = new Date(settlementTime.getTime() + this.config.exit_offset_seconds * 1000)
    const exitDecisionTs = toClickHouseDateTime(exitTime)
    const exitTs = applyOrderLatency(exitDecisionTs, this.orderLatencyMs)

    gated.advanceTo(exitTs)
    const exitCandle = gated.getRowAt(exitTs)
    if (!exitCandle) return null

    const exitFill = fillMarketOrder('sell', exitCandle, 1, 'exit', this.slippage)
    if (!exitFill) return null

    const fundingTs = toClickHouseDateTime(event.funding_time)
    const applyFunding = shouldApplyFunding({
      entryTs: entryFill.timestamp,
      exitTs: exitFill.timestamp,
      fundingTs,
    })

    const pnl = calculatePnl({
      direction: 'long',
      entryPrice: entryFill.price,
      exitPrice: exitFill.price,
      fundingRate: event.funding_rate,
      appliedFraction: fundingFraction(applyFunding),
      entryFeeType: 'taker',
      exitFeeType: 'taker',
      feeSchedule: this.feeSchedule,
    })

    const holdDuration = (exitTime.getTime() - entryTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: event.exchange,
      symbol: event.symbol,
      funding_time: event.funding_time,
      funding_rate: event.funding_rate,
      entry_price: entryFill.price,
      exit_price: exitFill.price,
      pnl,
      exit_reason: 'timed',
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: applyFunding,
      real_settlement_ts: tDropTs,
      real_settlement_detected: !noDropLocalized,
    }
  }
}
