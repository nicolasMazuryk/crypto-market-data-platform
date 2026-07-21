import type { FeeSchedule, Strategy1WsConfig, FundingSettlementConfig } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { toClickHouseDateTime } from '../../db/types.js'
import { applyOrderLatency } from '../engine/latency.js'
import { computeTDropOffsetSeconds } from '../engine/localization.js'
import { eventMissDraw } from '../engine/seeded-rng.js'
import type { BaseStrategy, TradeResult, LookaheadContext } from './types.js'

const DEFAULT_WS_EVENT_CONFIG = { missRate: 0.02, extraDelaySeconds: 2 }

/**
 * Strategy 1-WS: Negative Funding LONG - Funding-Fee-Event Exit
 *
 * Same entry as S1 (§02_strategy_1_ws.md §6). Exit is event-driven, not timed: in live,
 * the engine exits on the WS funding-fee event; here that's emulated by exiting at
 * `max(T_drop, T_settle) + ws_exit_extra_delay_seconds` (the "event path"). A per-event
 * deterministic draw (`ws_event_miss_rate`) emulates the live fallback path where the WS
 * event is missed, in which case the exit instead fires at the fixed
 * `T_settle + funding_fee_timeout_seconds` deadline (the "timeout path").
 */
export class Strategy1Ws implements BaseStrategy {
  readonly id = 'strategy_1_ws'
  private config!: Strategy1WsConfig
  private feeSchedule!: FeeSchedule
  private slippage = 0
  private orderLatencyMs!: number
  private wsEventConfig: { missRate: number; extraDelaySeconds: number } = DEFAULT_WS_EVENT_CONFIG

  initialize(
    config: Strategy1WsConfig,
    feeSchedule: FeeSchedule,
    slippage: number,
    orderLatencyMs: number,
    fundingSettlement?: FundingSettlementConfig,
    wsEventConfig?: { missRate: number; extraDelaySeconds: number }
  ): void {
    void fundingSettlement
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
    this.orderLatencyMs = orderLatencyMs
    if (wsEventConfig) this.wsEventConfig = wsEventConfig
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate * 100 <= -Math.abs(this.config.negative_funding_threshold_percent)
  }

  execute(event: FundingEvent, _data: OHLCWindow, context?: LookaheadContext): TradeResult | null {
    void _data
    if (!context) throw new Error('strategy_1_ws requires a LookaheadContext')
    const { gated, tDropTs, noDropLocalized } = context

    // 1. Entry (reuse S1: decision at T_settle - entry_offset, latency-shifted fill).
    const entryTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const entryDecisionTs = toClickHouseDateTime(entryTime)
    const entryTs = applyOrderLatency(entryDecisionTs, this.orderLatencyMs)

    gated.advanceTo(entryTs)
    const entryCandle = gated.getRowAt(entryTs)
    if (!entryCandle) return null

    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry', this.slippage)
    if (!entryFill) return null

    const fundingTs = toClickHouseDateTime(event.funding_time)
    const fundingMs = event.funding_time.getTime()
    const tDropMs = new Date(tDropTs.replace(' ', 'T') + 'Z').getTime()

    // 2. Deterministic per-event miss draw emulating the live WS-event-miss fallback.
    const missed = eventMissDraw(event.exchange, event.symbol, event.funding_time) < this.wsEventConfig.missRate

    let exitDecisionMs: number
    let exitReason: 'funding_fee_event' | 'funding_fee_timeout'
    let clampFloorMs: number | undefined

    if (!missed) {
      // 3. Event path: exit at max(T_drop, T_settle) + extraDelaySeconds, clamped so the
      // fill never lands on the drop candle itself (§5.5.2 structural floor).
      exitDecisionMs = Math.max(tDropMs, fundingMs) + this.wsEventConfig.extraDelaySeconds * 1000
      exitReason = 'funding_fee_event'
      clampFloorMs = tDropMs + 1000
    } else {
      // 4. Timeout path: fixed fallback deadline off T_settle.
      exitDecisionMs = fundingMs + this.config.funding_fee_timeout_seconds * 1000
      exitReason = 'funding_fee_timeout'
    }

    const exitDecisionTs = toClickHouseDateTime(new Date(exitDecisionMs))
    let exitTs = applyOrderLatency(exitDecisionTs, this.orderLatencyMs)
    if (clampFloorMs !== undefined) {
      const clampFloorTs = toClickHouseDateTime(new Date(clampFloorMs))
      if (exitTs < clampFloorTs) exitTs = clampFloorTs
    }

    gated.advanceTo(exitTs)
    const exitCandle = gated.getRowAt(exitTs)
    if (!exitCandle) return null

    const exitFill = fillMarketOrder('sell', exitCandle, 1, 'exit', this.slippage)
    if (!exitFill) return null

    // 6. Funding + PnL (reuse S1).
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

    const exitTime = new Date(exitTs.replace(' ', 'T') + 'Z')
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
      exit_reason: exitReason,
      hold_duration: holdDuration,
      fill_count: 1,
      funding_received: applyFunding,
      real_settlement_ts: tDropTs,
      real_settlement_detected: !noDropLocalized,
      t_drop_offset_s: computeTDropOffsetSeconds(context, event.funding_time),
    }
  }
}
