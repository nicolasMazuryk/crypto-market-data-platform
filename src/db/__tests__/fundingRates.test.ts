import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'

import { config } from '../../config.js'
import { closeClickHouseClient, getClickHouseClient } from '../client.js'
import { pingClickHouse } from '../health.js'
import {
  getOldestFundingRateTime,
  insertFundingRates,
  getFundingRateRangeStats,
  listFundingRateCompletenessGaps,
  listFundingRateTimeGaps,
  listFundingRatesByExchange,
  listFundingRatesByExchangeSymbolRange,
  listFundingRateTimesByExchangeSymbolRange,
} from '../queries/fundingRates.js'
import { toClickHouseDateTime, type FundingRateRow } from '../types.js'

interface ColumnDef {
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
    const januaryRow = januaryRows[0]
    if (!januaryRow) {
      throw new Error('Expected January funding rate row')
    }
    expect(Number(januaryRow.funding_rate)).toBeCloseTo(0.0001)
  })

  it('lists funding rate times and range stats', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `times_${runId}`
    const symbol = `SYM_${runId}`

    const january = new Date(Date.UTC(2025, 0, 10, 0, 0, 0))
    const february = new Date(Date.UTC(2025, 1, 10, 0, 0, 0))

    const rows: FundingRateRow[] = [
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(january),
        funding_rate: '0.00030000',
        mark_price: '100.00000000',
        created_at: toClickHouseDateTime(january),
      },
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(february),
        funding_rate: '0.00040000',
        mark_price: '101.00000000',
        created_at: toClickHouseDateTime(february),
      },
    ]

    await insertFundingRates(rows)

    const januaryStart = toClickHouseDateTime(new Date(Date.UTC(2025, 0, 1, 0, 0, 0)))
    const februaryStart = toClickHouseDateTime(new Date(Date.UTC(2025, 1, 1, 0, 0, 0)))

    const times = await listFundingRateTimesByExchangeSymbolRange(exchange, symbol, januaryStart, februaryStart)
    expect(times.length).toBe(1)

    const stats = await getFundingRateRangeStats(exchange, symbol, januaryStart, februaryStart)
    expect(stats.count).toBe(1)
    expect(stats.min_time).toBe(times[0])
    expect(stats.max_time).toBe(times[0])
  })

  it('returns oldest funding rate timestamp per symbol', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `oldest_${runId}`
    const symbol = `SYM_${runId}`

    const older = new Date(Date.UTC(2025, 0, 5, 0, 0, 0))
    const newer = new Date(Date.UTC(2025, 0, 6, 0, 0, 0))

    await insertFundingRates([
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(newer),
        funding_rate: '0.00010000',
        mark_price: '100.00000000',
        created_at: toClickHouseDateTime(newer),
      },
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(older),
        funding_rate: '0.00020000',
        mark_price: '101.00000000',
        created_at: toClickHouseDateTime(older),
      },
    ])

    const oldest = await getOldestFundingRateTime(exchange, symbol)
    expect(oldest).toBeTruthy()
    expect(new Date((oldest ?? '').replace(' ', 'T') + 'Z').getTime()).toBe(older.getTime())
  })

  it('detects completeness gaps', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `gap_${runId}`
    const symbol = `SYM_${runId}`

    const t1 = new Date(Date.UTC(2025, 0, 1, 0, 0, 0))
    const t3 = new Date(Date.UTC(2025, 0, 1, 16, 0, 0))

    await insertFundingRates([
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(t1),
        funding_rate: '0.00010000',
        mark_price: '100.00000000',
        created_at: toClickHouseDateTime(t1),
      },
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(t3),
        funding_rate: '0.00020000',
        mark_price: '101.00000000',
        created_at: toClickHouseDateTime(t3),
      },
    ])

    const gaps = await listFundingRateCompletenessGaps()
    const match = gaps.find(entry => entry.exchange === exchange && entry.symbol === symbol)

    expect(match).toBeTruthy()
    expect(match?.expected).toBe(3)
    expect(match?.actual).toBe(2)
  })

  it('lists each time gap occurrence larger than 8 hours', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `timegap_${runId}`
    const symbol = `SYM_${runId}`

    const t1 = new Date(Date.UTC(2025, 0, 1, 0, 0, 0))
    const t2 = new Date(Date.UTC(2025, 0, 1, 8, 0, 0))
    const t3 = new Date(Date.UTC(2025, 0, 1, 20, 0, 0))
    const t4 = new Date(Date.UTC(2025, 0, 2, 16, 0, 0))

    await insertFundingRates([
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(t1),
        funding_rate: '0.00010000',
        mark_price: '100.00000000',
        created_at: toClickHouseDateTime(t1),
      },
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(t2),
        funding_rate: '0.00020000',
        mark_price: '101.00000000',
        created_at: toClickHouseDateTime(t2),
      },
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(t3),
        funding_rate: '0.00030000',
        mark_price: '102.00000000',
        created_at: toClickHouseDateTime(t3),
      },
      {
        exchange,
        symbol,
        exchange_symbol: symbol,
        funding_time: toClickHouseDateTime(t4),
        funding_rate: '0.00040000',
        mark_price: '103.00000000',
        created_at: toClickHouseDateTime(t4),
      },
    ])

    const allGaps = await listFundingRateTimeGaps()
    const symbolGaps = allGaps.filter(entry => entry.exchange === exchange && entry.symbol === symbol)

    expect(symbolGaps.length).toBe(2)
    expect(symbolGaps[0]?.prev_time).toBe(toClickHouseDateTime(t2))
    expect(symbolGaps[0]?.curr_time).toBe(toClickHouseDateTime(t3))
    expect(symbolGaps[0]?.gap_hours).toBe(12)
    expect(symbolGaps[1]?.prev_time).toBe(toClickHouseDateTime(t3))
    expect(symbolGaps[1]?.curr_time).toBe(toClickHouseDateTime(t4))
    expect(symbolGaps[1]?.gap_hours).toBe(20)
  })

  it('prevents duplicates within batch', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = `dedup_${runId}`
    const symbol = `SYM_${runId}`
    const now = new Date(Date.UTC(2025, 0, 15, 0, 0, 0))

    const row: FundingRateRow = {
      exchange,
      symbol,
      exchange_symbol: symbol,
      funding_time: toClickHouseDateTime(now),
      funding_rate: '0.00050000',
      mark_price: '123.45000000',
      created_at: toClickHouseDateTime(now),
    }

    // Insert batch with duplicates
    await insertFundingRates([row, row, row])

    // Query to verify only one record exists
    const rows = await listFundingRatesByExchange(exchange, 10)
    const matches = rows.filter(item => item.symbol === symbol && item.funding_time === toClickHouseDateTime(now))
    expect(matches.length).toBe(1)
  })
})
