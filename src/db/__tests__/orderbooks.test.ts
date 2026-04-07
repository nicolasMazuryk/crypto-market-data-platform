import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { config } from '../../config.js'
import { closeClickHouseClient, getClickHouseClient } from '../client.js'
import { createClickHouseFixtureCleanupRegistry } from '../fixtureCleanup.js'
import { pingClickHouse } from '../health.js'
import {
  countOrderbooks,
  deleteOrderbooksByExchangeSymbolDate,
  insertOrderbooks,
  listDistinctExchangeSymbolPairs,
  queryOrderbooks,
} from '../queries/orderbooks.js'
import { toClickHouseDateTime, type OrderbookRow } from '../types.js'

interface ColumnDef {
  name: string
  type: string
}

const database = config.clickhouse.database

const expectedColumns: ColumnDef[] = [
  { name: 'exchange', type: 'LowCardinality(String)' },
  { name: 'symbol', type: 'String' },
  { name: 'ts', type: 'DateTime' },
  { name: 'bid_open', type: 'Nullable(Float64)' },
  { name: 'bid_high', type: 'Nullable(Float64)' },
  { name: 'bid_low', type: 'Nullable(Float64)' },
  { name: 'bid_close', type: 'Nullable(Float64)' },
  { name: 'ask_open', type: 'Nullable(Float64)' },
  { name: 'ask_high', type: 'Nullable(Float64)' },
  { name: 'ask_low', type: 'Nullable(Float64)' },
  { name: 'ask_close', type: 'Nullable(Float64)' },
  { name: 'source_type', type: 'LowCardinality(String)' },
  { name: 'is_interpolated', type: 'Bool' },
  { name: 'confidence_score', type: 'LowCardinality(String)' },
  { name: 'missing_reason', type: 'Nullable(String)' },
]

const cleanupRegistry = createClickHouseFixtureCleanupRegistry()

function trackOrderbookExchange(exchange: string): string {
  cleanupRegistry.track('orderbooks', exchange)
  return exchange
}

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

function baseRow(exchange: string, symbol: string, ts: Date): OrderbookRow {
  return {
    exchange,
    symbol,
    ts: toClickHouseDateTime(ts),
    bid_open: 10,
    bid_high: 11,
    bid_low: 9,
    bid_close: 10.5,
    ask_open: 10.8,
    ask_high: 11.2,
    ask_low: 10.7,
    ask_close: 11,
    source_type: 'orderbook',
    is_interpolated: false,
    confidence_score: 'high',
    missing_reason: null,
  }
}

describe('orderbooks table', () => {
  beforeAll(async () => {
    const healthy = await pingClickHouse()
    if (!healthy) {
      throw new Error('ClickHouse is not reachable. Run: npm run db:up')
    }

    const client = getClickHouseClient()
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS arbinet.orderbooks
        (
            exchange LowCardinality(String),
            symbol String,
            ts DateTime,
            bid_open Nullable(Float64),
            bid_high Nullable(Float64),
            bid_low Nullable(Float64),
            bid_close Nullable(Float64),
            ask_open Nullable(Float64),
            ask_high Nullable(Float64),
            ask_low Nullable(Float64),
            ask_close Nullable(Float64),
            source_type LowCardinality(String),
            is_interpolated Bool DEFAULT false,
            confidence_score LowCardinality(String),
            missing_reason Nullable(String)
        )
        ENGINE = MergeTree
        PARTITION BY toYYYYMM(ts)
        ORDER BY (exchange, symbol, ts)
        SETTINGS index_granularity = 8192
      `,
    })
  })

  afterEach(async () => {
    await cleanupRegistry.cleanup()
  })

  afterAll(async () => {
    try {
      await cleanupRegistry.cleanup()
    } finally {
      await closeClickHouseClient()
    }
  })

  it('has expected schema', async () => {
    const columns = await fetchColumns('orderbooks')
    expect(columns.length).toBeGreaterThan(0)
    assertSchema(expectedColumns, columns)
  })

  it('inserts and queries orderbook rows by time range', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackOrderbookExchange(`ob_${runId}`)
    const symbol = `SYM_${runId}`

    const t1 = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    const t2 = new Date(Date.UTC(2026, 0, 1, 0, 0, 1))

    await insertOrderbooks([baseRow(exchange, symbol, t1), baseRow(exchange, symbol, t2)])

    const rows = await queryOrderbooks(
      exchange,
      symbol,
      toClickHouseDateTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))),
      toClickHouseDateTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 2)))
    )

    expect(rows.length).toBe(2)
    expect(rows[0]?.symbol).toBe(symbol)
    expect(rows[1]?.ts).toBe(toClickHouseDateTime(t2))
  })

  it('deletes rows by exchange/symbol/date', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackOrderbookExchange(`del_${runId}`)
    const symbol = `SYM_${runId}`

    await insertOrderbooks([
      baseRow(exchange, symbol, new Date(Date.UTC(2026, 0, 2, 0, 0, 0))),
      baseRow(exchange, symbol, new Date(Date.UTC(2026, 0, 2, 0, 0, 1))),
    ])

    await deleteOrderbooksByExchangeSymbolDate(exchange, symbol, '2026-01-02')

    const count = await countOrderbooks(exchange, symbol)
    expect(count).toBe(0)
  })

  it('lists distinct exchange/symbol pairs', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackOrderbookExchange(`pair_${runId}`)
    const symbol = `SYM_${runId}`

    await insertOrderbooks([baseRow(exchange, symbol, new Date(Date.UTC(2026, 0, 3, 0, 0, 0)))])

    const pairs = await listDistinctExchangeSymbolPairs()
    expect(pairs.some(pair => pair.exchange === exchange && pair.symbol === symbol)).toBe(true)
  })

  it('counts rows for an exchange/symbol', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackOrderbookExchange(`count_${runId}`)
    const symbol = `SYM_${runId}`

    await insertOrderbooks([
      baseRow(exchange, symbol, new Date(Date.UTC(2026, 0, 4, 0, 0, 0))),
      baseRow(exchange, symbol, new Date(Date.UTC(2026, 0, 4, 0, 0, 1))),
      baseRow(exchange, symbol, new Date(Date.UTC(2026, 0, 4, 0, 0, 2))),
    ])

    const count = await countOrderbooks(exchange, symbol)
    expect(count).toBe(3)
  })
})
