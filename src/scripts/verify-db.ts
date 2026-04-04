import { randomUUID } from 'crypto'

import { config } from '../config.js'
import { logger } from '../logger.js'
import { closeClickHouseClient, getClickHouseClient } from '../db/client.js'
import { assertClickHouseHealthy } from '../db/health.js'
import {
  getOldestFundingRateTime,
  insertFundingRates,
  listFundingRateCompletenessGaps,
  listFundingRatesByExchange,
  listFundingRatesByExchangeSymbolRange,
} from '../db/queries/fundingRates.js'
import { getMarketByExchangeSymbol, insertMarkets } from '../db/queries/markets.js'
import { toClickHouseDateTime, type FundingRateRow, type MarketRow } from '../db/types.js'

interface ColumnDef {
  name: string
  type: string
}

const database = config.clickhouse.database

const expectedMarketColumns: ColumnDef[] = [
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

const expectedFundingRateColumns: ColumnDef[] = [
  { name: 'exchange', type: 'LowCardinality(String)' },
  { name: 'symbol', type: 'String' },
  { name: 'exchange_symbol', type: 'String' },
  { name: 'funding_time', type: 'DateTime' },
  { name: 'funding_rate', type: 'Decimal(18, 8)' },
  { name: 'mark_price', type: 'Nullable(Decimal(18, 8))' },
  { name: 'created_at', type: 'DateTime' },
]

function logStep(message: string): void {
  logger.info({ step: message }, 'ClickHouse verify step')
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

async function fetchEngine(table: string): Promise<string | null> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: 'SELECT engine FROM system.tables WHERE database = {database: String} AND name = {table: String} LIMIT 1',
    query_params: { database, table },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ engine: string }>()
  return rows[0]?.engine ?? null
}

function assertSchema(table: string, expected: ColumnDef[], actual: ColumnDef[]): void {
  const actualMap = new Map(actual.map(column => [column.name, column.type]))
  const missing: string[] = []
  const mismatched: string[] = []

  for (const column of expected) {
    const found = actualMap.get(column.name)
    if (!found) {
      missing.push(column.name)
      continue
    }

    if (found !== column.type) {
      mismatched.push(`${column.name} (expected ${column.type}, got ${found})`)
    }
  }

  if (missing.length > 0 || mismatched.length > 0) {
    const details = [
      missing.length > 0 ? `Missing: ${missing.join(', ')}` : null,
      mismatched.length > 0 ? `Type mismatches: ${mismatched.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' | ')

    throw new Error(`Schema mismatch for ${table}. ${details}`)
  }
}

async function verifyDatabaseExists(): Promise<void> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: 'SELECT name FROM system.databases WHERE name = {database: String}',
    query_params: { database },
    format: 'JSONEachRow',
  })
  const rows = await result.json<{ name: string }>()

  if (rows.length === 0) {
    throw new Error(`Database not found: ${database}`)
  }
}

async function verifySchema(): Promise<void> {
  const marketColumns = await fetchColumns('markets')
  assertSchema('markets', expectedMarketColumns, marketColumns)

  const fundingColumns = await fetchColumns('funding_rates')
  assertSchema('funding_rates', expectedFundingRateColumns, fundingColumns)

  const fundingEngine = await fetchEngine('funding_rates')
  if (fundingEngine !== 'ReplacingMergeTree') {
    throw new Error(`Expected funding_rates engine ReplacingMergeTree, got ${fundingEngine ?? 'unknown'}`)
  }
}

async function verifyMarketQueries(): Promise<void> {
  const runId = randomUUID().slice(0, 8)
  const exchange = `verify_${runId}`
  const symbol = `VER_${runId}`
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

  await insertMarkets([firstRow])
  await insertMarkets([secondRow])

  const latest = await getMarketByExchangeSymbol(exchange, symbol, true)
  if (!latest) {
    throw new Error('Expected market row not found')
  }

  if (latest.is_active) {
    throw new Error('ReplacingMergeTree did not return latest market record')
  }
}

async function verifyFundingRateQueries(): Promise<void> {
  const runId = randomUUID().slice(0, 8)
  const exchange = `verify_${runId}`
  const symbol = `VER_${runId}`

  const first = new Date(Date.UTC(2025, 0, 15, 0, 0, 0))
  const second = new Date(Date.UTC(2025, 0, 15, 8, 0, 0))

  const rows: FundingRateRow[] = [
    {
      exchange,
      symbol,
      exchange_symbol: symbol,
      funding_time: toClickHouseDateTime(first),
      funding_rate: '0.00010000',
      mark_price: '100.00000000',
      created_at: toClickHouseDateTime(first),
    },
    {
      exchange,
      symbol,
      exchange_symbol: symbol,
      funding_time: toClickHouseDateTime(second),
      funding_rate: '0.00020000',
      mark_price: '101.00000000',
      created_at: toClickHouseDateTime(second),
    },
  ]

  await insertFundingRates(rows)

  const recent = await listFundingRatesByExchange(exchange, 10)
  if (recent.length < 2) {
    throw new Error('Expected funding rate rows not found for exchange')
  }

  const januaryStart = toClickHouseDateTime(new Date(Date.UTC(2025, 0, 1, 0, 0, 0)))
  const februaryStart = toClickHouseDateTime(new Date(Date.UTC(2025, 1, 1, 0, 0, 0)))

  const januaryRows = await listFundingRatesByExchangeSymbolRange(exchange, symbol, januaryStart, februaryStart)
  if (januaryRows.length !== 2) {
    throw new Error('Expected funding rate query to return two contiguous January rows')
  }

  const oldest = await getOldestFundingRateTime(exchange, symbol)
  if (!oldest || oldest !== toClickHouseDateTime(first)) {
    throw new Error('Expected getOldestFundingRateTime to return the January row')
  }

  const gaps = await listFundingRateCompletenessGaps()
  const hasGap = gaps.some(entry => entry.exchange === exchange && entry.symbol === symbol)
  if (hasGap) {
    throw new Error('Expected no completeness gap for contiguous funding rows')
  }
}

async function main(): Promise<void> {
  await assertClickHouseHealthy()
  logStep('ClickHouse ping succeeded')

  await verifyDatabaseExists()
  logStep(`Database ${database} exists`)

  await verifySchema()
  logStep('Schema matches expected definitions')

  await verifyMarketQueries()
  logStep('Markets inserts and queries verified')

  await verifyFundingRateQueries()
  logStep('Funding rates inserts and queries verified')

  logger.info('All ClickHouse checks passed')
}

try {
  await main()
} catch (error) {
  logger.error({ err: error }, 'ClickHouse verification failed')
  process.exitCode = 1
} finally {
  try {
    await closeClickHouseClient()
  } catch (error) {
    logger.error({ err: error }, 'Failed to close ClickHouse client')
  }
}
