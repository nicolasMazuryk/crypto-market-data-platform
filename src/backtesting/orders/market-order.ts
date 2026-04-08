import type { OrderbookRow } from '../../db/types.js'
import type { Fill, OrderSide } from './types.js'

/**
 * Simulate a market order fill.
 *
 * BUY MARKET fills at ask_open of the candle.
 * SELL MARKET fills at bid_open of the candle.
 */
export function fillMarketOrder(side: OrderSide, candle: OrderbookRow, quantity: number, label: string): Fill | null {
  let price: number | null

  if (side === 'buy') {
    price = candle.ask_open
  } else {
    price = candle.bid_open
  }

  if (price === null || price <= 0) {
    return null
  }

  return {
    timestamp: candle.ts,
    price,
    quantity,
    feeType: 'taker',
    label,
  }
}
