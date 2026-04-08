import type { OrderbookRow } from '../../db/types.js'
import type { Fill, OrderSide } from './types.js'

/**
 * Check if a stop-market order would trigger on this candle.
 *
 * BUY STOP at P_stop triggers when ask_high >= P_stop.
 * SELL STOP at P_stop triggers when bid_low <= P_stop.
 * Fill price = P_stop + slippage (for buy) or P_stop - slippage (for sell).
 */
export function checkStopFill(
  side: OrderSide,
  stopPrice: number,
  candle: OrderbookRow,
  quantity: number,
  slippage: number,
  label: string
): Fill | null {
  if (side === 'buy') {
    const askHigh = candle.ask_high
    if (askHigh === null) return null
    if (askHigh >= stopPrice) {
      return {
        timestamp: candle.ts,
        price: stopPrice * (1 + slippage),
        quantity,
        feeType: 'taker',
        label,
      }
    }
  } else {
    const bidLow = candle.bid_low
    if (bidLow === null) return null
    if (bidLow <= stopPrice) {
      return {
        timestamp: candle.ts,
        price: stopPrice * (1 - slippage),
        quantity,
        feeType: 'taker',
        label,
      }
    }
  }

  return null
}
