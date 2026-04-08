import { queryOrderbooks } from '../../db/queries/orderbooks.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { WindowConfig } from '../config/schema.js'
import { OHLCWindow } from './types.js'

export async function fetchOrderbookWindow(
  exchange: string,
  symbol: string,
  fundingTime: Date,
  config: WindowConfig
): Promise<OHLCWindow> {
  const startTime = toClickHouseDateTime(new Date(fundingTime.getTime() - config.pre_funding_seconds * 1000))
  // +1s makes endTime exclusive match inclusive [T + post_funding_seconds]
  const endTime = toClickHouseDateTime(new Date(fundingTime.getTime() + (config.post_funding_seconds + 1) * 1000))
  const rows = await queryOrderbooks(exchange, symbol, startTime, endTime)
  return new OHLCWindow(rows)
}
