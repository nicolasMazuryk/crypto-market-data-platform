import type { ClickHouseClient } from '@clickhouse/client'

import type { ChartConfig, FundingEvent, OrderbookRow } from './types.js'

function toClickHouseDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function parseClickHouseDateTime(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z')
}

export async function* streamFundingEvents(config: ChartConfig, client: ClickHouseClient): AsyncGenerator<FundingEvent> {

  const conditions: string[] = []

  if (config.threshold_mode === 'lte') {
    conditions.push(`funding_rate <= {threshold: Float64}`)
  } else if (config.threshold_mode === 'gte') {
    conditions.push(`funding_rate >= {threshold: Float64}`)
  } else {
    conditions.push(`abs(funding_rate) >= {threshold: Float64}`)
  }

  const queryParams: Record<string, unknown> = {
    threshold: Math.abs(config.funding_rate_threshold),
  }

  if (config.threshold_mode === 'lte') {
    queryParams.threshold = config.funding_rate_threshold
  }

  if (config.exchanges.length > 0) {
    conditions.push(`exchange IN ({exchanges: Array(String)})`)
    queryParams.exchanges = config.exchanges
  }

  if (config.symbols.length > 0) {
    conditions.push(`symbol IN ({symbols: Array(String)})`)
    queryParams.symbols = config.symbols
  }

  if (config.date_range.from) {
    conditions.push(`funding_time >= {dateFrom: DateTime}`)
    queryParams.dateFrom = config.date_range.from.replace('T', ' ').slice(0, 19)
  }

  if (config.date_range.to) {
    conditions.push(`funding_time <= {dateTo: DateTime}`)
    queryParams.dateTo = config.date_range.to.replace('T', ' ').slice(0, 19)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const query = `
    SELECT exchange, symbol, funding_time, toFloat64(funding_rate) AS funding_rate
    FROM arbinet.funding_rates
    ${whereClause}
    ORDER BY funding_time ASC, exchange ASC, symbol ASC
  `

  const resultSet = await client.query({
    query,
    query_params: queryParams,
    format: 'JSONEachRow',
  })

  const stream = resultSet.stream<{
    exchange: string
    symbol: string
    funding_time: string
    funding_rate: string
  }>()

  try {
    for await (const rows of stream) {
      for (const row of rows) {
        const r = row.json()
        yield {
          exchange: r.exchange,
          symbol: r.symbol,
          funding_time: parseClickHouseDateTime(r.funding_time),
          funding_rate: parseFloat(r.funding_rate),
        }
      }
    }
  } finally {
    resultSet.close()
  }
}

export async function fetchOrderbookWindow(
  client: ClickHouseClient,
  event: FundingEvent,
  preSec: number,
  postSec: number,
): Promise<OrderbookRow[]> {
  const fundingTimeSec = Math.floor(event.funding_time.getTime() / 1000)
  const fromDate = new Date((fundingTimeSec - preSec) * 1000)
  const toDate = new Date((fundingTimeSec + postSec) * 1000)

  const result = await client.query({
    query: `
      SELECT
        ts,
        bid_open, bid_high, bid_low, bid_close,
        ask_open, ask_high, ask_low, ask_close
      FROM arbinet.orderbooks
      WHERE exchange = {exchange: String}
        AND symbol = {symbol: String}
        AND ts >= {fromTime: DateTime}
        AND ts <= {toTime: DateTime}
      ORDER BY ts ASC
    `,
    query_params: {
      exchange: event.exchange,
      symbol: event.symbol,
      fromTime: toClickHouseDateTime(fromDate),
      toTime: toClickHouseDateTime(toDate),
    },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{
    ts: string
    bid_open: number | null
    bid_high: number | null
    bid_low: number | null
    bid_close: number | null
    ask_open: number | null
    ask_high: number | null
    ask_low: number | null
    ask_close: number | null
  }>()

  return rows.map((r) => ({
    ts: parseClickHouseDateTime(r.ts),
    bid_open: r.bid_open,
    bid_high: r.bid_high,
    bid_low: r.bid_low,
    bid_close: r.bid_close,
    ask_open: r.ask_open,
    ask_high: r.ask_high,
    ask_low: r.ask_low,
    ask_close: r.ask_close,
  }))
}
