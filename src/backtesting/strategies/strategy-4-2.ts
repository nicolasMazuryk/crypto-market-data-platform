import type { FeeSchedule, Strategy42Config, ExitReason, BacktestError } from '../config/schema.js'
import type { FundingEvent, OHLCWindow } from '../data/types.js'
import { fillMarketOrder } from '../orders/market-order.js'
import { checkOrderFeasibility } from '../orders/feasibility.js'
import { simulateLadderLifecycle, type LadderRungOrder } from '../orders/simulator.js'
import { calculateLadderPnl } from '../pnl/calculator.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { BaseStrategy, TradeResult } from './types.js'

/**
 * Backtest-only default market params (§G-R) — see strategy-4-1.ts for rationale.
 */
const DEFAULT_LOT_STEP = 1e-6
const DEFAULT_MIN_COST = 0
const DEFAULT_CONTRACT_SIZE = 1

function floorToStep(value: number, step: number): number {
  return Math.floor(value / step) * step
}

/**
 * Strategy 4.2a: Negative Funding Single LONG - Post-Funding Entry
 *
 * RECONCILIATION R11 lifecycle (identical live + backtest): single resting BUY LIMIT at
 * P_limit plus a conditional SL anchored to P_limit (precomputable, fixed for the lifecycle,
 * since the single-rung P_avg_full == P_limit), a TP re-placed at fill price on entry;
 * unfilled limit stays live until SL/TP/deadline fires. `FUNDING_PNL = 0` unconditionally
 * (R7), including pre-settlement fills. Mirrors strategy-4-1.ts as the single-rung case.
 */
export class Strategy42 implements BaseStrategy {
  readonly id: string
  private config!: Strategy42Config
  private feeSchedule!: FeeSchedule
  private slippage = 0

  constructor(variant: 'strategy_4_2a') {
    this.id = variant
  }

  initialize(config: Strategy42Config, feeSchedule: FeeSchedule, slippage: number, orderLatencyMs: number): void {
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

    const setupCandle = data.getRowAt(setupTs)
    if (setupCandle?.ask_open == null) return null
    const pCurrent = setupCandle.ask_open

    const limitPrice = pCurrent * (1 - absF * this.config.limit_offset_mult)

    // Size qty from notional, floored to the lot step (§6.1).
    const rawQty = this.config.amount_usd / pCurrent / DEFAULT_CONTRACT_SIZE
    const quantity = floorToStep(rawQty, DEFAULT_LOT_STEP)
    if (quantity <= 0) return null

    const rung: LadderRungOrder = { price: limitPrice, quantity, label: 'ladder_0' }

    // Top-rung (= only rung) feasibility gate (§G-R): skip the symbol if it fails minCost.
    const feasibility = checkOrderFeasibility({
      quantity: rung.quantity,
      price: rung.price,
      lotStep: DEFAULT_LOT_STEP,
      minCost: DEFAULT_MIN_COST,
      contractSize: DEFAULT_CONTRACT_SIZE,
    })
    if (!feasibility.feasible) return null

    // Single rung ⇒ P_avg_full == P_limit; SL anchored to P_limit, precomputable at placement.
    const slPrice = limitPrice * (1 - absF * this.config.sl_multiplier)

    const windowRows = data.getRowsInRange(setupTs, deadlineTs)
    if (windowRows.length === 0) return null

    const {
      fills,
      exit: lifecycleExit,
      preSettleFillCount,
    } = simulateLadderLifecycle({
      rungs: [rung],
      slPrice,
      takeProfitPct: this.config.take_profit_pct,
      candles: windowRows,
      fundingTs,
      slippage: this.slippage,
    })

    if (fills.length === 0) return { error_code: 'limit_expired' }

    const fill = fills[0]
    if (!fill) return { error_code: 'limit_expired' }
    const entryPrice = fill.price
    const filledQty = fill.quantity

    let exit: { price: number; reason: ExitReason; feeType: 'maker' | 'taker'; ts: string }

    if (lifecycleExit) {
      exit = lifecycleExit
    } else {
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
      avgEntryPrice: entryPrice,
      exitPrice: exit.price,
      fundingRate: event.funding_rate,
      appliedFraction: 0,
      numFilled: fills.length,
      exitFeeType: exit.feeType,
      feeSchedule: this.feeSchedule,
    })

    const entryTime = new Date(fill.timestamp.replace(' ', 'T') + 'Z')
    const exitTime = new Date(exit.ts.replace(' ', 'T') + 'Z')
    const holdDuration = (exitTime.getTime() - entryTime.getTime()) / 1000

    return {
      strategy_id: this.id,
      exchange: event.exchange,
      symbol: event.symbol,
      funding_time: event.funding_time,
      funding_rate: event.funding_rate,
      entry_price: entryPrice,
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
