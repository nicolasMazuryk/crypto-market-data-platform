import { getClickHouseClient } from '../client.js'
import type { FundingRateRow } from '../types.js'

const FUNDING_RATE_COLUMNS =
  'exchange, symbol, exchange_symbol, funding_time, funding_rate, mark_price, created_at'

export async function insertFundingRates(rows: FundingRateRow[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const client = getClickHouseClient()
  await client.insert({
    table: 'funding_rates',
    values: rows,
    format: 'JSONEachRow',
  })
}

export async function listFundingRatesByExchange(
  exchange: string,
  limit = 100
): Promise<FundingRateRow[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT ${FUNDING_RATE_COLUMNS} FROM funding_rates WHERE exchange = {exchange: String} ORDER BY funding_time DESC LIMIT {limit: UInt32}`,
    query_params: { exchange, limit },
    format: 'JSONEachRow',
  })

  return result.json<FundingRateRow[]>()
}

export async function listFundingRatesByExchangeSymbolRange(
  exchange: string,
  symbol: string,
  startTime: string,
  endTime: string
): Promise<FundingRateRow[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT ${FUNDING_RATE_COLUMNS} FROM funding_rates WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND funding_time >= {startTime: DateTime} AND funding_time < {endTime: DateTime} ORDER BY funding_time ASC`,
    query_params: { exchange, symbol, startTime, endTime },
    format: 'JSONEachRow',
  })

  return result.json<FundingRateRow[]>()
}
