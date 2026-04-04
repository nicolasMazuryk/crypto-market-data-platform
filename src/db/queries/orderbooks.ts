import { getClickHouseClient } from '../client.js'
import type { OrderbookRow } from '../types.js'

const INSERT_BATCH_SIZE = 10_000
const ORDERBOOK_COLUMNS =
  'exchange, symbol, ts, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close, source_type, is_interpolated, confidence_score, missing_reason'

export interface OrderbookPair {
  exchange: string
  symbol: string
}

export async function insertOrderbooks(rows: OrderbookRow[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const client = getClickHouseClient()

  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + INSERT_BATCH_SIZE)
    await client.insert({
      table: 'orderbooks',
      values: batch,
      format: 'JSONEachRow',
    })
  }
}

export async function deleteOrderbooksByExchangeSymbolDate(
  exchange: string,
  symbol: string,
  date: string
): Promise<void> {
  const client = getClickHouseClient()

  await client.command({
    query:
      'ALTER TABLE orderbooks DELETE WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND toDate(ts) = {date: Date}',
    query_params: { exchange, symbol, date },
    clickhouse_settings: {
      mutations_sync: '1',
    },
  })
}

export async function queryOrderbooks(
  exchange: string,
  symbol: string,
  startTime?: string,
  endTime?: string
): Promise<OrderbookRow[]> {
  const client = getClickHouseClient()
  const filters = ['exchange = {exchange: String}', 'symbol = {symbol: String}']
  const queryParams: Record<string, string> = { exchange, symbol }

  if (startTime) {
    filters.push('ts >= {startTime: DateTime}')
    queryParams.startTime = startTime
  }

  if (endTime) {
    filters.push('ts < {endTime: DateTime}')
    queryParams.endTime = endTime
  }

  const result = await client.query({
    query: `SELECT ${ORDERBOOK_COLUMNS} FROM orderbooks WHERE ${filters.join(' AND ')} ORDER BY ts ASC`,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  return result.json<OrderbookRow>()
}

export async function* streamOrderbookRows(
  exchange: string,
  symbol: string,
  startTime?: string,
  endTime?: string
): AsyncIterable<OrderbookRow> {
  const client = getClickHouseClient()
  const filters = ['exchange = {exchange: String}', 'symbol = {symbol: String}']
  const queryParams: Record<string, string> = { exchange, symbol }

  if (startTime) {
    filters.push('ts >= {startTime: DateTime}')
    queryParams.startTime = startTime
  }

  if (endTime) {
    filters.push('ts < {endTime: DateTime}')
    queryParams.endTime = endTime
  }

  const result = await client.query({
    query: `SELECT ${ORDERBOOK_COLUMNS} FROM orderbooks WHERE ${filters.join(' AND ')} ORDER BY ts ASC`,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const stream = result.stream<OrderbookRow>()

  try {
    for await (const rows of stream) {
      for (const row of rows) {
        yield row.json()
      }
    }
  } finally {
    result.close()
  }
}

export async function listDistinctExchangeSymbolPairs(): Promise<OrderbookPair[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: 'SELECT DISTINCT exchange, symbol FROM orderbooks ORDER BY exchange ASC, symbol ASC',
    format: 'JSONEachRow',
  })

  return result.json<OrderbookPair>()
}

export async function countOrderbooks(exchange: string, symbol: string): Promise<number> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: 'SELECT count() as count FROM orderbooks WHERE exchange = {exchange: String} AND symbol = {symbol: String}',
    query_params: { exchange, symbol },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ count: string | number }>()
  return Number(rows[0]?.count ?? 0)
}
