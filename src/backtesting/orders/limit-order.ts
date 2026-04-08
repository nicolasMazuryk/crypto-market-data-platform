import type { OrderbookRow } from '../../db/types.js'
import type { Fill, OrderSide } from './types.js'

/**
 * Check if a limit order would fill on this candle.
 *
 * BUY LIMIT at P_limit fills when ask_low < P_limit.
 * SELL LIMIT at P_limit fills when bid_high > P_limit.
 * Fill price = the limit price itself.
 */
export function checkLimitFill(
  side: OrderSide,
  limitPrice: number,
  candle: OrderbookRow,
  quantity: number,
  label: string
): Fill | null {
  if (side === 'buy') {
    const askLow = candle.ask_low
    if (askLow === null) return null
    if (askLow < limitPrice) {
      return {
        timestamp: candle.ts,
        price: limitPrice,
        quantity,
        feeType: 'maker',
        label,
      }
    }
  } else {
    const bidHigh = candle.bid_high
    if (bidHigh === null) return null
    if (bidHigh > limitPrice) {
      return {
        timestamp: candle.ts,
        price: limitPrice,
        quantity,
        feeType: 'maker',
        label,
      }
    }
  }

  return null
}
