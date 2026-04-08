import { getClickHouseClient } from '../../db/client.js'
import { toClickHouseDateTime } from '../../db/types.js'
import type { OrderbookRow } from '../../db/types.js'
import type { WindowConfig } from '../config/schema.js'
import { OHLCWindow } from './types.js'

const ORDERBOOK_COLUMNS =
  'exchange, symbol, ts, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close, source_type, is_interpolated, confidence_score, missing_reason'

export async function fetchOrderbookWindow(
  exchange: string,
  symbol: string,
  fundingTime: Date,
  config: WindowConfig
): Promise<OHLCWindow> {
  const startTime = new Date(fundingTime.getTime() - config.pre_funding_seconds * 1000)
  const endTime = new Date(fundingTime.getTime() + config.post_funding_seconds * 1000)

  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT ${ORDERBOOK_COLUMNS} FROM orderbooks WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND ts >= {startTime: DateTime} AND ts <= {endTime: DateTime} ORDER BY ts ASC`,
    query_params: {
      exchange,
      symbol,
      startTime: toClickHouseDateTime(startTime),
      endTime: toClickHouseDateTime(endTime),
    },
    format: 'JSONEachRow',
  })

  const rows = await result.json<OrderbookRow>()
  return new OHLCWindow(rows)
}
