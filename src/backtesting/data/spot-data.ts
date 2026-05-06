import type { WindowConfig } from '../config/schema.js'
import type { OHLCWindow } from './types.js'
import { fetchOrderbookWindow } from './orderbook-window.js'

/**
 * Fetch the spot orderbook window for a symbol around a funding time.
 *
 * TEMPORARY: aliased to the perp orderbook source until spot OHLC data
 * is ingested into ClickHouse. When real spot data lands, replace the
 * body of this function — no other call site needs to change.
 */
export async function fetchSpotOrderbookWindow(
  spotExchange: string,
  symbol: string,
  fundingTime: Date,
  windowConfig: WindowConfig
): Promise<OHLCWindow> {
  return fetchOrderbookWindow(spotExchange, symbol, fundingTime, windowConfig)
}
