import { logger } from '../../logger.js'
import { getClickHouseClient } from '../client.js'
import type { FundingRateRow } from '../types.js'

const FUNDING_RATE_COLUMNS =
  'exchange, symbol, exchange_symbol, funding_time, funding_rate, mark_price, created_at'
const FUNDING_RATE_TIME_COLUMNS = 'funding_time'

export type FundingRateCompletenessGap = {
  exchange: string
  symbol: string
  expected: number
  actual: number
}

export async function insertFundingRates(rows: FundingRateRow[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  // Deduplicate within batch, keeping latest created_at
  const seen = new Map<string, FundingRateRow>()

  for (const row of rows) {
    const key = `${row.exchange}:${row.symbol}:${row.funding_time}`
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, row)
    } else {
      // Keep the one with latest created_at
      const currentTime = row.created_at || new Date().toISOString()
      const existingTime = existing.created_at || new Date().toISOString()

      if (currentTime > existingTime) {
        seen.set(key, row)
        logger.warn(
          {
            exchange: row.exchange,
            symbol: row.symbol,
            funding_time: row.funding_time,
          },
          'Replacing duplicate funding rate in batch with newer version'
        )
      }
    }
  }

  const uniqueRows = Array.from(seen.values())
  const client = getClickHouseClient()
  await client.insert({
    table: 'funding_rates',
    values: uniqueRows,
    format: 'JSONEachRow',
  })
}

export async function listFundingRateTimesByExchangeSymbolRange(
  exchange: string,
  symbol: string,
  startTime: string,
  endTime: string
): Promise<string[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT ${FUNDING_RATE_TIME_COLUMNS} FROM funding_rates WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND funding_time >= {startTime: DateTime} AND funding_time < {endTime: DateTime} ORDER BY funding_time ASC`,
    query_params: { exchange, symbol, startTime, endTime },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ funding_time: string }[]>()
  return rows.map((row) => row.funding_time)
}

export async function getFundingRateRangeStats(
  exchange: string,
  symbol: string,
  startTime: string,
  endTime: string
): Promise<{ count: number; min_time: string | null; max_time: string | null }> {
  const client = getClickHouseClient()
  const result = await client.query({
    query:
      'SELECT count() as count, min(funding_time) as min_time, max(funding_time) as max_time FROM funding_rates WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND funding_time >= {startTime: DateTime} AND funding_time < {endTime: DateTime}',
    query_params: { exchange, symbol, startTime, endTime },
    format: 'JSONEachRow',
  })

  const rows = await result.json<
    { count: string | number; min_time: string | null; max_time: string | null }[]
  >()
  const row = rows[0]
  return {
    count: row ? Number(row.count) : 0,
    min_time: row?.min_time ?? null,
    max_time: row?.max_time ?? null,
  }
}

export async function getOldestFundingRateTime(
  exchange: string,
  symbol: string
): Promise<string | null> {
  const client = getClickHouseClient()
  const result = await client.query({
    query:
      'SELECT min(funding_time) as oldest_time FROM funding_rates WHERE exchange = {exchange: String} AND symbol = {symbol: String}',
    query_params: { exchange, symbol },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ oldest_time: string | null }[]>()
  return rows[0]?.oldest_time ?? null
}

export async function listFundingRateCompletenessGaps(): Promise<FundingRateCompletenessGap[]> {
  const client = getClickHouseClient()
  const buildQuery = (useFinal: boolean): string => {
    const source = useFinal ? 'funding_rates FINAL' : 'funding_rates'
    return `
      SELECT
        exchange,
        symbol,
        count() + sum(greatest(0, toInt32(ceil(ifNull(diff_hours, 0) / 8.0)) - 1)) AS expected,
        count() AS actual
      FROM (
        SELECT
          exchange,
          symbol,
          if(
            row_number() OVER (
              PARTITION BY exchange, symbol
              ORDER BY funding_time ASC
            ) = 1,
            0,
            dateDiff(
              'hour',
              lagInFrame(funding_time) OVER (
                PARTITION BY exchange, symbol
                ORDER BY funding_time ASC
              ),
              funding_time
            )
          ) AS diff_hours
        FROM ${source}
      )
      GROUP BY exchange, symbol
      HAVING expected != actual
      ORDER BY exchange ASC, symbol ASC
    `
  }

  const readRows = async (useFinal: boolean): Promise<
    Array<{
      exchange: string
      symbol: string
      expected: number | string
      actual: number | string
    }>
  > => {
    const result = await client.query({
      query: buildQuery(useFinal),
      format: 'JSONEachRow',
    })

    const rows: Array<{
      exchange: string
      symbol: string
      expected: number | string
      actual: number | string
    }> = await result.json()
    return rows
  }

  let rows: Array<{
    exchange: string
    symbol: string
    expected: number | string
    actual: number | string
  }>

  try {
    rows = await readRows(true)
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (!message.includes("doesn't support final")) {
      throw error
    }

    rows = await readRows(false)
  }

  return rows.map((row) => ({
    exchange: row.exchange,
    symbol: row.symbol,
    expected: Number(row.expected),
    actual: Number(row.actual),
  }))
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

  return result.json<FundingRateRow>()
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

  return result.json<FundingRateRow>()
}

export type SymbolValidationResult = {
  exchange: string
  expectedSymbols: string[]
  actualSymbols: string[]
  missingSymbols: string[]
  extraSymbols: string[]
  isMatch: boolean
}

/**
 * Gets symbols from markets table that were listed before or during the data period
 * and were NOT delisted before DATA_PERIOD_START.
 * These are the symbols that should have funding rate data.
 */
export async function getExpectedSymbolsForExchange(
  exchange: string,
  dataPeriodStart: string,
  dataPeriodEnd: string | null,
  useFinal = false
): Promise<string[]> {
  const client = getClickHouseClient()
  const finalClause = useFinal ? ' FINAL' : ''
  
  // Build query with listing_date check
  // Include markets where:
  // - listing_date IS NULL (unknown listing date, assume valid)
  // - OR listing_date <= dataPeriodEnd (listed before or during the period)
  // AND
  // - delisting_date IS NULL (not delisted)
  // - OR delisting_date >= dataPeriodStart (not delisted before period start)
  let query = `
    SELECT DISTINCT symbol
    FROM markets${finalClause}
    WHERE exchange = {exchange: String}
      AND (delisting_date IS NULL OR delisting_date >= {dataPeriodStart: DateTime})
  `
  
  const queryParams: Record<string, unknown> = {
    exchange,
    dataPeriodStart,
  }
  
  if (dataPeriodEnd) {
    query += ` AND (listing_date IS NULL OR listing_date <= {dataPeriodEnd: DateTime})`
    queryParams.dataPeriodEnd = dataPeriodEnd
  }
  
  query += ` ORDER BY symbol`
  
  const result = await client.query({
    query,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ symbol: string }[]>()
  return rows.map((row) => row.symbol)
}

/**
 * Gets distinct symbols from funding_rates table for an exchange.
 */
export async function getActualSymbolsForExchange(
  exchange: string,
  useFinal = false
): Promise<string[]> {
  const client = getClickHouseClient()
  const finalClause = useFinal ? ' FINAL' : ''
  const result = await client.query({
    query: `
      SELECT DISTINCT symbol
      FROM funding_rates${finalClause}
      WHERE exchange = {exchange: String}
      ORDER BY symbol
    `,
    query_params: { exchange },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ symbol: string }[]>()
  return rows.map((row) => row.symbol)
}

/**
 * Validates that symbols in funding_rates match expected symbols from markets table.
 * Returns validation result with discrepancies if any.
 */
export async function validateSymbolsForExchange(
  exchange: string,
  dataPeriodStart: string,
  dataPeriodEnd: string | null
): Promise<SymbolValidationResult> {
  const readResult = async (useFinal: boolean): Promise<SymbolValidationResult> => {
    const expectedSymbols = await getExpectedSymbolsForExchange(
      exchange,
      dataPeriodStart,
      dataPeriodEnd,
      useFinal
    )
    const actualSymbols = await getActualSymbolsForExchange(exchange, useFinal)

    const expectedSet = new Set(expectedSymbols)
    const actualSet = new Set(actualSymbols)

    const missingSymbols = expectedSymbols.filter((s) => !actualSet.has(s))
    const extraSymbols = actualSymbols.filter((s) => !expectedSet.has(s))

    return {
      exchange,
      expectedSymbols,
      actualSymbols,
      missingSymbols,
      extraSymbols,
      isMatch: missingSymbols.length === 0 && extraSymbols.length === 0,
    }
  }

  try {
    return await readResult(true)
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (!message.includes("doesn't support final")) {
      throw error
    }

    return await readResult(false)
  }
}
