import type { FeeSchedule, Strategy2Config, FundingSettlementConfig } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import type { OrderbookRow } from '../../db/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkLimitFill } from '../orders/limit-order.js'
import { checkStopFill } from '../orders/stop-order.js'
import { calculatePnl } from '../pnl/calculator.js'
import { shouldApplyFunding, fundingFraction } from '../pnl/funding-applicability.js'
import { toClickHouseDateTime } from '../../db/types.js'
import { computeTDropOffsetSeconds } from '../engine/localization.js'
import { eventMissDraw } from '../engine/seeded-rng.js'
import type { BaseStrategy, TradeResult, LookaheadContext } from './types.js'
import type { ExitReason } from '../config/schema.js'

const DEFAULT_WS_EVENT_CONFIG = { missRate: 0.02, extraDelaySeconds: 2 }

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
  private wsEventConfig: { missRate: number; extraDelaySeconds: number } = DEFAULT_WS_EVENT_CONFIG

  initialize(
    config: Strategy2Config,
    feeSchedule: FeeSchedule,
    slippage: number,
    orderLatencyMs: number,
    fundingSettlement?: FundingSettlementConfig,
    wsEventConfig?: { missRate: number; extraDelaySeconds: number }
  ): void {
    // TODO(task-1N): wire latency shift
    void orderLatencyMs
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
    if (fundingSettlement) this.fundingSettlement = fundingSettlement
    if (wsEventConfig) this.wsEventConfig = wsEventConfig
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

    const entryFill = fillMarketOrder('buy', entryCandle, 1, 'entry', this.slippage)
    if (!entryFill) return null

    const slPrice = entryFill.price * (1 - absF * this.config.sl_multiplier)

    // Anchor = entry-decision reference price (T_settle - entry_offset_seconds), bid basis.
    if (entryCandle.bid_open == null) return null
    const anchor = entryCandle.bid_open

    // TP cannot become valid until max(T_low+1s, T_drop + buffer), and never before
    // T_drop + 1s (structural floor: credit-gated action never fires on the drop candle).
    const tDropEpochMs = new Date(tDropTs.replace(' ', 'T') + 'Z').getTime()
    const structuralFloorMs = tDropEpochMs + 1000
    const bufferMs = this.fundingSettlement.tp_post_settlement_buffer_seconds * 1000
    const settlementEpochMs = Math.max(structuralFloorMs, tDropEpochMs + bufferMs)

    // Arming: live tracker arms at T_drop, or (on a deterministic per-event WS-miss draw) the
    // fixed T_settle + funding_fee_timeout_seconds fallback. On the no_drop_localized fallback,
    // tDropTs is already the window edge, so the non-missed branch covers that arming source too.
    const missed = eventMissDraw(event.exchange, event.symbol, event.funding_time) < this.wsEventConfig.missRate
    const armMs = missed
      ? event.funding_time.getTime() + this.config.funding_fee_timeout_seconds * 1000
      : tDropEpochMs
    const armTs = toClickHouseDateTime(new Date(armMs))

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

    for (let sec = 0; entryMs + sec * 1000 <= deadlineMs; sec++) {
      const rowTs = toClickHouseDateTime(new Date(entryMs + sec * 1000))
      if (rowTs > gated.getCurrentTime()) gated.advanceTo(rowTs)
      const row = gated.getRowAt(rowTs)
      if (!row) continue
      seenAny = true
      lastRow = row

      const isEntryCandle = sec === 0

      const slFill = checkStopFill('sell', slPrice, row, 1, this.slippage, 'sl')
      const tpFill =
        !isEntryCandle && activeTpPrice !== undefined && activeTpFrom !== undefined && row.ts >= activeTpFrom
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

      if (row.ts >= armTs && row.ts <= deadlineTs && row.bid_low !== null && row.bid_low < pLow) {
        pLow = row.bid_low
        if (anchor > pLow) {
          activeTpPrice = pLow + (anchor - pLow) * this.config.retracement_pct
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
        const deadlineFill = fillMarketOrder('sell', deadlineCandle, 1, 'deadline', this.slippage)
        if (!deadlineFill) return null
        exit = { price: deadlineFill.price, reason: 'deadline', feeType: 'taker', ts: deadlineTs }
      } else {
        if (!lastRow) return null
        const lastFill = fillMarketOrder('sell', lastRow, 1, 'deadline', this.slippage)
        if (!lastFill) return null
        exit = { price: lastFill.price, reason: 'deadline', feeType: 'taker', ts: deadlineTs }
      }
    }

    const applyFunding = shouldApplyFunding({
      entryTs,
      exitTs: exit.ts,
      fundingTs,
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
      t_drop_offset_s: computeTDropOffsetSeconds(context, event.funding_time),
    }
  }
}
