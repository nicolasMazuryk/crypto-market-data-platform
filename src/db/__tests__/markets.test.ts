import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'

import { config } from '../../config.js'
import { closeClickHouseClient, getClickHouseClient } from '../client.js'
import { pingClickHouse } from '../health.js'
import { getMarketByExchangeSymbol, insertMarkets, listMarketsByExchange } from '../queries/markets.js'
import { toClickHouseDateTime, type MarketRow } from '../types.js'

interface ColumnDef {
  name: string
  type: string
}

const database = config.clickhouse.database

const expectedColumns: ColumnDef[] = [
  { name: 'exchange', type: 'LowCardinality(String)' },
  { name: 'symbol', type: 'String' },
  { name: 'exchange_symbol', type: 'String' },
  { name: 'type', type: 'LowCardinality(String)' },
  { name: 'listing_date', type: 'Nullable(DateTime)' },
  { name: 'delisting_date', type: 'Nullable(DateTime)' },
  { name: 'is_active', type: 'Bool' },
  { name: 'created_at', type: 'DateTime' },
  { name: 'updated_at', type: 'DateTime' },
]

async function fetchColumns(table: string): Promise<ColumnDef[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query:
      'SELECT name, type FROM system.columns WHERE database = {database: String} AND table = {table: String} ORDER BY position',
    query_params: { database, table },
    format: 'JSONEachRow',
  })

  return result.json<ColumnDef>()
}

function assertSchema(expected: ColumnDef[], actual: ColumnDef[]): void {
  const actualMap = new Map(actual.map(column => [column.name, column.type]))

  for (const column of expected) {
    const found = actualMap.get(column.name)
    expect(found, `Missing column ${column.name}`).toBeTruthy()
    expect(found).toBe(column.type)
  }
}

describe('markets table', () => {
  beforeAll(async () => {
    const healthy = await pingClickHouse()
    if (!healthy) {
      throw new Error('ClickHouse is not reachable. Run: npm run db:up')
    }
  })

  afterAll(async () => {
    await closeClickHouseClient()
  })

  it('has expected schema', async () => {
    const columns = await fetchColumns('markets')
    expect(columns.length).toBeGreaterThan(0)
    assertSchema(expectedColumns, columns)
  })

  it('inserts and queries markets by exchange', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `test_${runId}`
    const symbol = `SYM_${runId}`
    const now = new Date()

    const row: MarketRow = {
      exchange,
      symbol,
      exchange_symbol: symbol,
      type: 'swap',
      listing_date: toClickHouseDateTime(now),
      delisting_date: null,
      is_active: true,
    }

    await insertMarkets([row])

    const rows = await listMarketsByExchange(exchange)
    const match = rows.find(item => item.symbol === symbol)
    expect(match).toBeTruthy()
  })

  it('deduplicates with ReplacingMergeTree', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `replace_${runId}`
    const symbol = `DEDUP_${runId}`
    const now = new Date()
    const earlier = new Date(now.getTime() - 60_000)

    const firstRow: MarketRow = {
      exchange,
      symbol,
      exchange_symbol: symbol,
      type: 'swap',
      listing_date: toClickHouseDateTime(earlier),
      delisting_date: null,
      is_active: true,
      created_at: toClickHouseDateTime(earlier),
      updated_at: toClickHouseDateTime(earlier),
    }

    const secondRow: MarketRow = {
      ...firstRow,
      is_active: false,
      created_at: toClickHouseDateTime(now),
      updated_at: toClickHouseDateTime(now),
    }

    await insertMarkets([firstRow, secondRow])

    const latest = await getMarketByExchangeSymbol(exchange, symbol, true)
    expect(latest).toBeTruthy()
    expect(latest?.is_active).toBe(false)
  })
})
