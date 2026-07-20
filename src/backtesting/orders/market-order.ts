import type { OrderbookRow } from '../../db/types.js'
import type { Fill, OrderSide } from './types.js'

/**
 * Simulate a market order fill.
 *
 * BUY MARKET fills at ask_open of the candle, adjusted adversely for slippage.
 * SELL MARKET fills at bid_open of the candle, adjusted adversely for slippage.
 */
export function fillMarketOrder(
  side: OrderSide,
  candle: OrderbookRow,
  quantity: number,
  label: string,
  slippage = 0
): Fill | null {
  let rawPrice: number | null

  if (side === 'buy') {
    rawPrice = candle.ask_open
  } else {
    rawPrice = candle.bid_open
  }

  if (rawPrice === null || rawPrice <= 0) {
    return null
  }

  const price = side === 'buy' ? rawPrice * (1 + slippage) : rawPrice * (1 - slippage)

  return {
    timestamp: candle.ts,
    price,
    quantity,
    feeType: 'taker',
    label,
  }
}
