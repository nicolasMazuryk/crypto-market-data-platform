import type { FeeSchedule, Strategy41Config, ExitReason, BacktestError } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkOrderFeasibility } from '../orders/feasibility.js'
import { simulateLadderLifecycle, type LadderRungOrder } from '../orders/simulator.js'
import { calculateLadderPnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'

/**
 * Backtest-only default market params (§G-R). The backtest has no real per-symbol CCXT
 * metadata, so it uses safe constants across the full range of markets/prices/quantities:
 * a fine lot step (doesn't distort the largest-remainder split) and a zero minCost (drop/skip
 * only trigger when a test overrides these constants explicitly).
 */
const DEFAULT_LOT_STEP = 1e-6
const DEFAULT_MIN_COST = 0
const DEFAULT_CONTRACT_SIZE = 1

function floorToStep(value: number, step: number): number {
  return Math.floor(value / step) * step
}

/**
 * Strategy 4.1a: Negative Funding Ladder LONG - Post-Funding Entry
 *
 * RECONCILIATION R11 lifecycle (`05_strategy_4_1a.md` §2, identical live + backtest):
 * place all rung BUY LIMITs plus the SL together, SL anchored to P_avg_full over the placed
 * rungs (precomputable, fixed for the lifecycle); on the first rung fill place a TP at P_avg,
 * re-placed on each deeper fill; unfilled rungs stay live until SL/TP/deadline fires.
 * `FUNDING_PNL = 0` unconditionally (R7), including pre-settlement fills.
 */
export class Strategy41 implements BaseStrategy {
  readonly id: string
  private config!: Strategy41Config
  private feeSchedule!: FeeSchedule
  private slippage = 0

  constructor(variant: 'strategy_4_1a') {
    this.id = variant
  }

  initialize(config: Strategy41Config, feeSchedule: FeeSchedule, slippage: number, orderLatencyMs: number): void {
    // TODO(task-1N): wire latency shift
    void orderLatencyMs
    this.config = config
    this.feeSchedule = feeSchedule
    this.slippage = slippage
  }

  shouldTrigger(event: FundingEvent): boolean {
    return event.funding_rate * 100 <= -Math.abs(this.config.negative_funding_threshold_percent)
  }

  execute(event: FundingEvent, data: OHLCWindow): TradeResult | BacktestError | null {
    const absF = Math.abs(event.funding_rate)
    const setupTime = new Date(event.funding_time.getTime() - this.config.entry_offset_seconds * 1000)
    const deadlineTime = new Date(event.funding_time.getTime() + this.config.deadline_seconds * 1000)

    const setupTs = toClickHouseDateTime(setupTime)
    const deadlineTs = toClickHouseDateTime(deadlineTime)
    const fundingTs = toClickHouseDateTime(event.funding_time)

    // Record P_current from ask price at setup time
    const setupCandle = data.getRowAt(setupTs)
    if (setupCandle?.ask_open == null) return null
    const pCurrent = setupCandle.ask_open

    // Compute ladder range
    const ladderTop = pCurrent * (1 - absF * this.config.ladder_top_mult)
    const ladderBottom = pCurrent * (1 - absF * this.config.ladder_bottom_mult)
    const n = this.config.ladder_count

    // Total qty from notional, floored to the lot step (§6.1).
    const rawQty = this.config.amount_usd / pCurrent / DEFAULT_CONTRACT_SIZE
    const totalQty = floorToStep(rawQty, DEFAULT_LOT_STEP)
    if (totalQty <= 0) return null

    // Largest-remainder distribution over the lot step (mirrors live strategy_4_1a.ts).
    const baseQty = floorToStep(totalQty / n, DEFAULT_LOT_STEP)
    const remainderUnits = Math.round((totalQty - baseQty * n) / DEFAULT_LOT_STEP)

    const rungSpecs: LadderRungOrder[] = Array.from({ length: n }, (_, i) => {
      const price = n === 1 ? ladderTop : ladderTop - (i * (ladderTop - ladderBottom)) / (n - 1)
      const quantity = baseQty + (i < remainderUnits ? DEFAULT_LOT_STEP : 0)
      return { price, quantity, label: `ladder_${String(i)}` }
    })

    // Top-rung feasibility gate (§G-R): skip the whole symbol if the most favorably priced
    // rung fails minCost at the split quantity.
    const topRung = rungSpecs[0]
    if (!topRung || topRung.quantity <= 0) return null
    const topFeasibility = checkOrderFeasibility({
      quantity: topRung.quantity,
      price: topRung.price,
      lotStep: DEFAULT_LOT_STEP,
      minCost: DEFAULT_MIN_COST,
      contractSize: DEFAULT_CONTRACT_SIZE,
    })
    if (!topFeasibility.feasible) return null

    // Drop sub-min-notional rungs at placement; the ladder may go out with fewer than
    // ladder_count orders.
    const placedRungs = rungSpecs.filter(rung => {
      if (rung.quantity <= 0) return false
      return checkOrderFeasibility({
        quantity: rung.quantity,
        price: rung.price,
        lotStep: DEFAULT_LOT_STEP,
        minCost: DEFAULT_MIN_COST,
        contractSize: DEFAULT_CONTRACT_SIZE,
      }).feasible
    })
    if (placedRungs.length === 0) return null

    // SL placed WITH the ladder, anchored to P_avg_full over the PLACED rungs — precomputable,
    // fixed for the whole lifecycle (R11).
    let pAvgFullNotional = 0
    let pAvgFullQty = 0
    for (const rung of placedRungs) {
      pAvgFullNotional += rung.price * rung.quantity
      pAvgFullQty += rung.quantity
    }
    const pAvgFull = pAvgFullNotional / pAvgFullQty
    const slPrice = pAvgFull * (1 - absF * this.config.sl_multiplier)

    // Get candles for the fill window
    const windowRows = data.getRowsInRange(setupTs, deadlineTs)
    if (windowRows.length === 0) return null

    // Unified candle-by-candle lifecycle: rung fills, dynamic-qty SL, TP arm/re-place.
    const {
      fills,
      exit: lifecycleExit,
      preSettleFillCount,
    } = simulateLadderLifecycle({
      rungs: placedRungs,
      slPrice,
      takeProfitPct: this.config.take_profit_pct,
      candles: windowRows,
      fundingTs,
      slippage: this.slippage,
    })

    if (fills.length === 0) return { error_code: 'ladder_no_fills' }

    // Compute P_avg (weighted average of filled prices)
    let totalQtyPrice = 0
    let filledQty = 0
    for (const fill of fills) {
      totalQtyPrice += fill.price * fill.quantity
      filledQty += fill.quantity
    }
    const pAvg = totalQtyPrice / filledQty

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string }

    if (lifecycleExit) {
      exit = lifecycleExit
    } else {
      // Unfilled rungs cancelled only now (deadline); market-close whatever is filled.
      const deadlineCandle = data.getRowAt(deadlineTs)
      if (deadlineCandle) {
        const deadlineFill = fillMarketOrder('sell', deadlineCandle, filledQty, 'deadline', this.slippage)
        if (!deadlineFill) return null
        exit = { price: deadlineFill.price, reason: 'deadline', feeType: 'taker', ts: deadlineTs }
      } else {
        const lastRow = windowRows[windowRows.length - 1]
        if (!lastRow) return null
        const lastFill = fillMarketOrder('sell', lastRow, filledQty, 'deadline', this.slippage)
        if (!lastFill) return null
        exit = { price: lastFill.price, reason: 'deadline', feeType: 'taker', ts: deadlineTs }
      }
    }

    // FUNDING_PNL = 0 unconditional for 4.* (R7), including pre-settlement fills.
    const pnl = calculateLadderPnl({
      direction: 'long',
      avgEntryPrice: pAvg,
      exitPrice: exit.price,
      filledQty,
      committedCapital: this.config.amount_usd,
      fundingRate: event.funding_rate,
      appliedFraction: 0,
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
      funding_received: false,
      pre_settle_fill_count: preSettleFillCount,
    }
  }
}
