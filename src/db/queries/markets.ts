import { getClickHouseClient } from '../client.js'
import type { MarketRow } from '../types.js'

const MARKET_COLUMNS =
  'exchange, symbol, exchange_symbol, type, listing_date, delisting_date, is_active, created_at, updated_at'

export async function insertMarkets(rows: MarketRow[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const client = getClickHouseClient()
  await client.insert({
    table: 'markets',
    values: rows,
    format: 'JSONEachRow',
  })
}

export async function listMarketsByExchange(
  exchange: string,
  useFinal = false
): Promise<MarketRow[]> {
  const client = getClickHouseClient()
  const finalClause = useFinal ? ' FINAL' : ''
  const result = await client.query({
    query: `SELECT ${MARKET_COLUMNS} FROM markets${finalClause} WHERE exchange = {exchange: String} ORDER BY symbol`,
    query_params: { exchange },
    format: 'JSONEachRow',
  })

  return result.json<MarketRow>()
}

export async function getMarketByExchangeSymbol(
  exchange: string,
  symbol: string,
  useFinal = false
): Promise<MarketRow | null> {
  const client = getClickHouseClient()
  const finalClause = useFinal ? ' FINAL' : ''
  const result = await client.query({
    query: `SELECT ${MARKET_COLUMNS} FROM markets${finalClause} WHERE exchange = {exchange: String} AND symbol = {symbol: String} LIMIT 1`,
    query_params: { exchange, symbol },
    format: 'JSONEachRow',
  })

  const rows = await result.json<MarketRow>()
  return rows[0] ?? null
}
