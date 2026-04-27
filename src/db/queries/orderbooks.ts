import { getClickHouseClient } from '../client.js'
import type { OrderbookRow } from '../types.js'

const INSERT_BATCH_SIZE = 10_000
const ORDERBOOK_COLUMNS =
  'exchange, symbol, ts, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close, source_type, is_interpolated, confidence_score, missing_reason'

export interface OrderbookPair {
  exchange: string
  symbol: string
}

export interface OrderbookLiteRow {
  ts: string | number | Date
  bid_close: number | null
  ask_close: number | null
  is_interpolated: boolean
}

export interface OrderbookAggregateRow {
  exchange: string
  symbol: string
  row_count: string | number
  first_ts_ms: string | number
  last_ts_ms: string | number
  expected_candles: string | number
  ohlc_constraint_violation_count: string | number
  partial_ohlc_count: string | number
  negative_price_count: string | number
  zero_price_non_interp_count: string | number
  spread_open_violations: string | number
  spread_high_violations: string | number
  spread_low_violations: string | number
  spread_close_violations: string | number
  nan_count: string | number
  infinity_count: string | number
  interpolated_count: string | number
  spread_sample_count: string | number
  spread_mean_bps: string | number | null
  spread_stddev_bps: string | number | null
  spread_median_bps: string | number | null
  spread_p75_bps: string | number | null
  spread_p95_bps: string | number | null
  spread_p99_bps: string | number | null
  spread_unreasonable_count_500: string | number
  spread_unreasonable_count_100: string | number
  exchange_values: string[]
  symbol_values: string[]
  source_type_values: string[]
  confidence_score_values: string[]
  first_source_type: string
  first_confidence_score: string
  confidence_mismatch_count: string | number
  bid_close_min: string | number | null
  bid_close_max: string | number | null
  bid_close_mean: string | number | null
  ask_close_min: string | number | null
  ask_close_max: string | number | null
  ask_close_mean: string | number | null
}

export interface OrderbookPerDayRow {
  exchange: string
  symbol: string
  day: string
  candle_count: string | number
  interpolated_count: string | number
  first_ts_ms: string | number
  last_ts_ms: string | number
  first_bid_close: number | null
  first_ask_close: number | null
  last_bid_close: number | null
  last_ask_close: number | null
}

export interface OrderbookCrossExchangeRow {
  symbol: string
  ts_ms: string | number
  exchanges: string[]
  mid_prices: (string | number)[]
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

export async function deleteOrderbooksByExchange(exchange: string): Promise<void> {
  const client = getClickHouseClient()

  await client.command({
    query: 'ALTER TABLE orderbooks DELETE WHERE exchange = {exchange: String}',
    query_params: { exchange },
    clickhouse_settings: {
      mutations_sync: '1',
    },
  })
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

export async function* streamOrderbookLiteRows(exchange: string, symbol: string): AsyncIterable<OrderbookLiteRow> {
  const client = getClickHouseClient()
  const result = await client.query({
    query:
      'SELECT ts, bid_close, ask_close, is_interpolated FROM orderbooks WHERE exchange = {exchange: String} AND symbol = {symbol: String} ORDER BY ts ASC',
    query_params: { exchange, symbol },
    format: 'JSONEachRow',
  })

  const stream = result.stream<OrderbookLiteRow>()

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

const SPREAD_FILTER =
  'NOT is_interpolated AND bid_close IS NOT NULL AND ask_close IS NOT NULL AND isFinite(bid_close) AND isFinite(ask_close) AND (bid_close + ask_close) > 0'
const SPREAD_BPS_EXPR = '(ask_close - bid_close) / ((bid_close + ask_close) / 2) * 10000'

export async function queryOrderbookAggregates(): Promise<OrderbookAggregateRow[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `
SELECT
  exchange,
  symbol,
  count()                                                                                          AS row_count,
  toUnixTimestamp(min(ts)) * 1000                                                                  AS first_ts_ms,
  toUnixTimestamp(max(ts)) * 1000                                                                  AS last_ts_ms,
  dateDiff('second', min(ts), max(ts)) + 1                                                         AS expected_candles,

  -- OHLC constraint violations (high < low, high < open, high < close, low > open, low > close) × 2 sides
  countIf(bid_high IS NOT NULL AND bid_low   IS NOT NULL AND bid_high  < bid_low)   +
  countIf(bid_high IS NOT NULL AND bid_open  IS NOT NULL AND bid_high  < bid_open)  +
  countIf(bid_high IS NOT NULL AND bid_close IS NOT NULL AND bid_high  < bid_close) +
  countIf(bid_low  IS NOT NULL AND bid_open  IS NOT NULL AND bid_low   > bid_open)  +
  countIf(bid_low  IS NOT NULL AND bid_close IS NOT NULL AND bid_low   > bid_close) +
  countIf(ask_high IS NOT NULL AND ask_low   IS NOT NULL AND ask_high  < ask_low)   +
  countIf(ask_high IS NOT NULL AND ask_open  IS NOT NULL AND ask_high  < ask_open)  +
  countIf(ask_high IS NOT NULL AND ask_close IS NOT NULL AND ask_high  < ask_close) +
  countIf(ask_low  IS NOT NULL AND ask_open  IS NOT NULL AND ask_low   > ask_open)  +
  countIf(ask_low  IS NOT NULL AND ask_close IS NOT NULL AND ask_low   > ask_close) AS ohlc_constraint_violation_count,

  -- Partial OHLC: some fields non-null but not all (per side, summed)
  countIf(
    (bid_open IS NOT NULL OR bid_high IS NOT NULL OR bid_low IS NOT NULL OR bid_close IS NOT NULL) AND
    (bid_open IS NULL     OR bid_high IS NULL     OR bid_low IS NULL     OR bid_close IS NULL)
  ) +
  countIf(
    (ask_open IS NOT NULL OR ask_high IS NOT NULL OR ask_low IS NOT NULL OR ask_close IS NOT NULL) AND
    (ask_open IS NULL     OR ask_high IS NULL     OR ask_low IS NULL     OR ask_close IS NULL)
  )                                                                                                AS partial_ohlc_count,

  -- Negative prices (any non-null price field < 0)
  countIf(
    (bid_open  IS NOT NULL AND bid_open  < 0) OR (bid_high  IS NOT NULL AND bid_high  < 0) OR
    (bid_low   IS NOT NULL AND bid_low   < 0) OR (bid_close IS NOT NULL AND bid_close < 0) OR
    (ask_open  IS NOT NULL AND ask_open  < 0) OR (ask_high  IS NOT NULL AND ask_high  < 0) OR
    (ask_low   IS NOT NULL AND ask_low   < 0) OR (ask_close IS NOT NULL AND ask_close < 0)
  )                                                                                                AS negative_price_count,

  -- Zero prices on non-interpolated orderbook rows
  countIf(
    source_type = 'orderbook' AND NOT is_interpolated AND (
      (bid_open  IS NOT NULL AND bid_open  = 0) OR (bid_high  IS NOT NULL AND bid_high  = 0) OR
      (bid_low   IS NOT NULL AND bid_low   = 0) OR (bid_close IS NOT NULL AND bid_close = 0) OR
      (ask_open  IS NOT NULL AND ask_open  = 0) OR (ask_high  IS NOT NULL AND ask_high  = 0) OR
      (ask_low   IS NOT NULL AND ask_low   = 0) OR (ask_close IS NOT NULL AND ask_close = 0)
    )
  )                                                                                                AS zero_price_non_interp_count,

  -- Negative spread violations per OHLC field
  countIf(bid_open  IS NOT NULL AND ask_open  IS NOT NULL AND bid_open  > ask_open)               AS spread_open_violations,
  countIf(bid_high  IS NOT NULL AND ask_high  IS NOT NULL AND bid_high  > ask_high)               AS spread_high_violations,
  countIf(bid_low   IS NOT NULL AND ask_low   IS NOT NULL AND bid_low   > ask_low)                AS spread_low_violations,
  countIf(bid_close IS NOT NULL AND ask_close IS NOT NULL AND bid_close > ask_close)              AS spread_close_violations,

  -- NaN / Infinity (rare but checked)
  countIf(
    isNaN(bid_open)  OR isNaN(bid_high)  OR isNaN(bid_low)  OR isNaN(bid_close) OR
    isNaN(ask_open)  OR isNaN(ask_high)  OR isNaN(ask_low)  OR isNaN(ask_close)
  )                                                                                                AS nan_count,
  countIf(
    isInfinite(bid_open)  OR isInfinite(bid_high)  OR isInfinite(bid_low)  OR isInfinite(bid_close) OR
    isInfinite(ask_open)  OR isInfinite(ask_high)  OR isInfinite(ask_low)  OR isInfinite(ask_close)
  )                                                                                                AS infinity_count,

  -- Interpolation
  countIf(is_interpolated)                                                                         AS interpolated_count,

  -- Spread distribution (server-side quantiles replace JS array sort)
  countIf(${SPREAD_FILTER})                                                                        AS spread_sample_count,
  avgIf(${SPREAD_BPS_EXPR}, ${SPREAD_FILTER})                                                      AS spread_mean_bps,
  stddevPopIf(${SPREAD_BPS_EXPR}, ${SPREAD_FILTER})                                               AS spread_stddev_bps,
  quantileIf(0.5)(${SPREAD_BPS_EXPR}, ${SPREAD_FILTER})                                           AS spread_median_bps,
  quantileIf(0.75)(${SPREAD_BPS_EXPR}, ${SPREAD_FILTER})                                          AS spread_p75_bps,
  quantileIf(0.95)(${SPREAD_BPS_EXPR}, ${SPREAD_FILTER})                                          AS spread_p95_bps,
  quantileIf(0.99)(${SPREAD_BPS_EXPR}, ${SPREAD_FILTER})                                          AS spread_p99_bps,
  countIf(${SPREAD_FILTER} AND ${SPREAD_BPS_EXPR} > 500)                                          AS spread_unreasonable_count_500,
  countIf(${SPREAD_FILTER} AND ${SPREAD_BPS_EXPR} > 100)                                          AS spread_unreasonable_count_100,

  -- Schema metadata
  groupUniqArray(exchange)                                                                          AS exchange_values,
  groupUniqArray(symbol)                                                                            AS symbol_values,
  groupUniqArray(source_type)                                                                       AS source_type_values,
  groupUniqArray(confidence_score)                                                                  AS confidence_score_values,
  anyIf(source_type, NOT is_interpolated)                                                           AS first_source_type,
  any(confidence_score)                                                                             AS first_confidence_score,
  countIf(
    (source_type = 'orderbook' AND confidence_score != 'high') OR
    (source_type = 'trades'    AND confidence_score != 'low')
  )                                                                                                AS confidence_mismatch_count,

  -- Price stats for PriceReasonableness
  min(bid_close)  AS bid_close_min,
  max(bid_close)  AS bid_close_max,
  avg(bid_close)  AS bid_close_mean,
  min(ask_close)  AS ask_close_min,
  max(ask_close)  AS ask_close_max,
  avg(ask_close)  AS ask_close_mean

FROM orderbooks
GROUP BY exchange, symbol
ORDER BY exchange ASC, symbol ASC
`,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: 600 },
  })

  return result.json<OrderbookAggregateRow>()
}

export async function queryOrderbookPerDayStats(): Promise<OrderbookPerDayRow[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `
SELECT
  exchange,
  symbol,
  toString(toDate(ts))              AS day,
  count()                           AS candle_count,
  countIf(is_interpolated)          AS interpolated_count,
  toUnixTimestamp(min(ts)) * 1000   AS first_ts_ms,
  toUnixTimestamp(max(ts)) * 1000   AS last_ts_ms,
  argMin(bid_close, ts)             AS first_bid_close,
  argMin(ask_close, ts)             AS first_ask_close,
  argMax(bid_close, ts)             AS last_bid_close,
  argMax(ask_close, ts)             AS last_ask_close
FROM orderbooks
GROUP BY exchange, symbol, toDate(ts)
ORDER BY exchange ASC, symbol ASC, day ASC
`,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: 600 },
  })

  return result.json<OrderbookPerDayRow>()
}

export async function queryOrderbookCrossExchangeOverlap(symbols: string[]): Promise<OrderbookCrossExchangeRow[]> {
  if (symbols.length === 0) {
    return []
  }

  const client = getClickHouseClient()
  const result = await client.query({
    query: `
SELECT
  symbol,
  toUnixTimestamp(ts) * 1000                                AS ts_ms,
  groupArray(exchange)                                       AS exchanges,
  groupArray(toFloat64((bid_close + ask_close) / 2))        AS mid_prices
FROM orderbooks
WHERE
  bid_close IS NOT NULL AND ask_close IS NOT NULL AND
  isFinite(bid_close) AND isFinite(ask_close) AND
  symbol IN ({symbols: Array(String)})
GROUP BY symbol, ts
HAVING length(exchanges) >= 2
ORDER BY symbol ASC, ts ASC
`,
    query_params: { symbols },
    format: 'JSONEachRow',
  })

  return result.json<OrderbookCrossExchangeRow>()
}
