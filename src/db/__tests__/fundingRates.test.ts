import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'

import { config } from '../../config.js'
import { closeClickHouseClient, getClickHouseClient } from '../client.js'
import { pingClickHouse } from '../health.js'
import {
  insertFundingRates,
  listFundingRatesByExchange,
  listFundingRatesByExchangeSymbolRange,
} from '../queries/fundingRates.js'
import { toClickHouseDateTime, type FundingRateRow } from '../types.js'

type ColumnDef = {
  name: string
  type: string
}

const database = config.clickhouse.database

const expectedColumns: ColumnDef[] = [
  { name: 'exchange', type: 'LowCardinality(String)' },
  { name: 'symbol', type: 'String' },
  { name: 'exchange_symbol', type: 'String' },
  { name: 'funding_time', type: 'DateTime' },
  { name: 'funding_rate', type: 'Decimal(18, 8)' },
  { name: 'mark_price', type: 'Nullable(Decimal(18, 8))' },
  { name: 'created_at', type: 'DateTime' },
]

async function fetchColumns(table: string): Promise<ColumnDef[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query:
      'SELECT name, type FROM system.columns WHERE database = {database: String} AND table = {table: String} ORDER BY position',
    query_params: { database, table },
    format: 'JSONEachRow',
  })

  return result.json<ColumnDef[]>()
}

function assertSchema(expected: ColumnDef[], actual: ColumnDef[]): void {
  const actualMap = new Map(actual.map(column => [column.name, column.type]))

  for (const column of expected) {
    const found = actualMap.get(column.name)
    expect(found, `Missing column ${column.name}`).toBeTruthy()
    expect(found).toBe(column.type)
  }
}

describe('funding_rates table', () => {
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
    const columns = await fetchColumns('funding_rates')
    expect(columns.length).toBeGreaterThan(0)
    assertSchema(expectedColumns, columns)
  })

  it('inserts and queries funding rates by exchange', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `fund_${runId}`
    const symbol = `SYM_${runId}`
    const now = new Date()

    const row: FundingRateRow = {
      exchange,
      symbol,
      exchange_symbol: symbol,
      funding_time: toClickHouseDateTime(now),
      funding_rate: '0.00050000',
      mark_price: '123.45000000',
      created_at: toClickHouseDateTime(now),
    }

    await insertFundingRates([row])

    const rows = await listFundingRatesByExchange(exchange, 10)
    const match = rows.find(item => item.symbol === symbol)
    expect(match).toBeTruthy()
  })

  it('filters by symbol and time range (partitioned by month)', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `range_${runId}`
    const symbol = `SYM_${runId}`

    const january = new Date(Date.UTC(2025, 0, 20, 0, 0, 0))
    const february = new Date(Date.UTC(2025, 1, 20, 0, 0, 0))

    const rows: FundingRateRow[] = [
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(january),
        funding_rate: '0.00010000',
        mark_price: '100.00000000',
        created_at: toClickHouseDateTime(january),
      },
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(february),
        funding_rate: '0.00020000',
        mark_price: '101.00000000',
        created_at: toClickHouseDateTime(february),
      },
    ]

    await insertFundingRates(rows)

    const januaryStart = toClickHouseDateTime(new Date(Date.UTC(2025, 0, 1, 0, 0, 0)))
    const februaryStart = toClickHouseDateTime(new Date(Date.UTC(2025, 1, 1, 0, 0, 0)))

    const januaryRows = await listFundingRatesByExchangeSymbolRange(exchange, symbol, januaryStart, februaryStart)
    expect(januaryRows.length).toBe(1)
    expect(Number(januaryRows[0].funding_rate)).toBeCloseTo(0.0001)
  })
})
