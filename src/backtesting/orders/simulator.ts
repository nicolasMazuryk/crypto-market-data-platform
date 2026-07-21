import { toClickHouseDateTime } from '../../db/types.js'
import type { OrderbookRow } from '../../db/types.js'
import { checkLimitFill } from './limit-order.js'
import { checkStopFill } from './stop-order.js'
import type { Fill, FeeType, Order } from './types.js'

export interface SimulationWarning {
  timestamp: string
  message: string
}

export interface SimulationResult {
  fills: Fill[]
  warnings: SimulationWarning[]
}

/**
 * Simulate a set of orders against a candle series.
 *
 * For SL/TP same-candle ambiguity: worst-case (SL wins) for both longs and shorts.
 * Orders are only checked within their [validFrom, validUntil] range.
 *
 * @param orders - Active orders to simulate (limit and stop orders)
 * @param candles - 1-second candle data sorted by timestamp
 * @param slippage - Stop order slippage fraction
 * @param positionDirection - 'long' or 'short' (affects worst-case resolution)
 * @param positionSize - When provided, caps cumulative reduce-only fill quantity at this size
 * @returns Fills and warnings
 */
export function simulateOrders(
  orders: Order[],
  candles: OrderbookRow[],
  slippage: number,
  positionDirection: 'long' | 'short',
  positionSize?: number
): SimulationResult {
  const fills: Fill[] = []
  const warnings: SimulationWarning[] = []
  const filledLabels = new Set<string>()
  let remaining = positionSize

  for (const candle of candles) {
    const ts = candle.ts

    // Collect potential fills for this candle
    const candleFills: { fill: Fill; order: Order }[] = []

    for (const order of orders) {
      if (filledLabels.has(order.label)) continue
      if (ts < order.validFrom || ts > order.validUntil) continue

      let fill: Fill | null = null

      if (order.type === 'limit' && order.price !== undefined) {
        fill = checkLimitFill(order.side, order.price, candle, order.quantity, order.label)
      } else if (order.type === 'stop' && order.price !== undefined) {
        fill = checkStopFill(order.side, order.price, candle, order.quantity, slippage, order.label)
      }

      if (fill && order.reduceOnly && remaining !== undefined) {
        if (remaining <= 0) {
          warnings.push({
            timestamp: ts,
            message: `Reduce-only order "${order.label}" skipped: position already fully closed.`,
          })
          continue
        }
        if (fill.quantity > remaining) {
          fill = { ...fill, quantity: remaining }
        }
        remaining -= fill.quantity
      }

      if (fill) {
        candleFills.push({ fill, order })
      }
    }

    if (candleFills.length === 0) continue

    // Check for SL/TP ambiguity (both filling in the same candle)
    const slFill = candleFills.find(f => f.order.label === 'sl')
    const tpFill = candleFills.find(f => f.order.label === 'tp')

    if (slFill && tpFill) {
      // Worst-case: SL wins for both longs and shorts
      warnings.push({
        timestamp: ts,
        message: `SL and TP both triggered on same candle. Applying worst-case (SL). Position: ${positionDirection}`,
      })
      fills.push(slFill.fill)
      filledLabels.add('sl')
      filledLabels.add('tp') // Cancel TP since SL won
    } else {
      // No ambiguity — process all fills
      for (const { fill } of candleFills) {
        if (!filledLabels.has(fill.label)) {
          fills.push(fill)
          filledLabels.add(fill.label)
        }
      }
    }

    // Once SL or TP fills, cancel the other (OCO behavior)
    if (filledLabels.has('sl') && !filledLabels.has('tp')) {
      filledLabels.add('tp')
    } else if (filledLabels.has('tp') && !filledLabels.has('sl')) {
      filledLabels.add('sl')
    }
  }

  return { fills, warnings }
}

/**
 * For ladder strategies: simulate multiple independent limit orders.
 * Each order is checked independently; fills are tracked separately.
 */
export function simulateLadderOrders(orders: Order[], candles: OrderbookRow[]): { fills: Fill[]; unfilled: number } {
  const fills: Fill[] = []
  let unfilled = 0

  for (const order of orders) {
    let filled = false
    for (const candle of candles) {
      if (candle.ts < order.validFrom || candle.ts > order.validUntil) continue
      if (order.type === 'limit' && order.price !== undefined) {
        const fill = checkLimitFill(order.side, order.price, candle, order.quantity, order.label)
        if (fill) {
          fills.push(fill)
          filled = true
          break
        }
      }
    }
    if (!filled) {
      unfilled++
    }
  }

  return { fills, unfilled }
}

export interface LadderRungOrder {
  price: number
  quantity: number
  label: string
}

export interface LadderExit {
  price: number
  reason: 'sl_hit' | 'tp_hit'
  feeType: FeeType
  ts: string
}

export interface LadderLifecycleParams {
  /** Rungs actually placed (post min-notional drop / top-rung skip), ordered top-to-bottom. */
  rungs: LadderRungOrder[]
  /** SL trigger price, precomputed from P_avg_full over placed rungs. Fixed for the whole lifecycle. */
  slPrice: number
  /** Take-profit percent above the running fill-weighted average (e.g. 0.2 for 0.2%). */
  takeProfitPct: number
  /** Candles from ladder placement through the deadline, inclusive, ascending. */
  candles: OrderbookRow[]
  fundingTs: string
  slippage: number
}

export interface LadderLifecycleResult {
  fills: Fill[]
  exit?: LadderExit
  /** Rungs filled before fundingTs (R7 audit — funding is never booked regardless). */
  preSettleFillCount: number
}

function addOneSecond(ts: string): string {
  return toClickHouseDateTime(new Date(new Date(ts.replace(' ', 'T') + 'Z').getTime() + 1000))
}

/**
 * R11 ladder lifecycle: rung limit fills, a fixed dynamic-qty SL gated on filledQty > 0, and a
 * TP that arms on the first fill and re-prices on each deeper fill (effective the following
 * candle; suppressed on any candle where a rung itself fills, so a rung fill never races its own
 * TP re-place — see `05_strategy_4_1a.md` §6). SL/TP same-candle ambiguity resolves SL-first.
 * Unfilled rungs are left live for the caller to treat as still-open past this window; this
 * function only reports fills and the first SL/TP exit encountered.
 */
export function simulateLadderLifecycle(params: LadderLifecycleParams): LadderLifecycleResult {
  const { rungs, slPrice, takeProfitPct, candles, fundingTs, slippage } = params
  const fills: Fill[] = []
  const filledLabels = new Set<string>()
  let filledQty = 0
  let filledNotional = 0
  let preSettleFillCount = 0
  let tpActive = false
  let tpPrice: number | undefined
  let tpQty = 0
  let tpEffectiveFromTs: string | undefined
  let exit: LadderExit | undefined

  for (const candle of candles) {
    const newFills: Fill[] = []
    for (const rung of rungs) {
      if (filledLabels.has(rung.label)) continue
      const fill = checkLimitFill('buy', rung.price, candle, rung.quantity, rung.label)
      if (fill) {
        filledLabels.add(rung.label)
        fills.push(fill)
        newFills.push(fill)
      }
    }

    if (newFills.length > 0) {
      for (const fill of newFills) {
        filledQty += fill.quantity
        filledNotional += fill.quantity * fill.price
        if (fill.timestamp < fundingTs) preSettleFillCount++
      }
    }

    // SL is engine-tracked from placement, active once any qty is filled, sized to currently
    // filled qty; may act on the same candle as a rung fill (worst outcome, §5.5.4).
    if (filledQty > 0) {
      const slFill = checkStopFill('sell', slPrice, candle, filledQty, slippage, 'sl')
      if (slFill) {
        exit = { price: slFill.price, reason: 'sl_hit', feeType: 'taker', ts: slFill.timestamp }
        break
      }
    }

    // No rung's TP may act on the candle that rung filled — skip the TP check entirely on any
    // candle with a new rung fill (whether the TP is the pre-existing one or about to be re-placed).
    if (
      newFills.length === 0 &&
      tpActive &&
      tpPrice !== undefined &&
      tpEffectiveFromTs !== undefined &&
      candle.ts >= tpEffectiveFromTs
    ) {
      const tpFill = checkLimitFill('sell', tpPrice, candle, tpQty, 'tp')
      if (tpFill) {
        exit = { price: tpFill.price, reason: 'tp_hit', feeType: 'maker', ts: tpFill.timestamp }
        break
      }
    }

    if (newFills.length > 0) {
      tpActive = true
      tpPrice = (filledNotional / filledQty) * (1 + takeProfitPct / 100)
      tpQty = filledQty
      tpEffectiveFromTs = addOneSecond(candle.ts)
    }
  }

  return { fills, preSettleFillCount, ...(exit !== undefined ? { exit } : {}) }
}
