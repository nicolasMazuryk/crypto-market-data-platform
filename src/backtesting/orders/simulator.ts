import type { OrderbookRow } from '../../db/types.js'
import { checkLimitFill } from './limit-order.js'
import { checkStopFill } from './stop-order.js'
import type { Fill, Order } from './types.js'

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
 * @returns Fills and warnings
 */
export function simulateOrders(
  orders: Order[],
  candles: OrderbookRow[],
  slippage: number,
  positionDirection: 'long' | 'short'
): SimulationResult {
  const fills: Fill[] = []
  const warnings: SimulationWarning[] = []
  const filledLabels = new Set<string>()

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
