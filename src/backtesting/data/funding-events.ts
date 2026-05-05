import { getClickHouseClient } from '../../db/client.js'
import type { FundingEvent } from './types.js'

export interface CrossFundingEvent {
  symbol: string
  funding_time: Date
  funding_rate_a: number
  funding_rate_b: number
}

export async function queryFundingEvents(
  exchange: string,
  symbol: string | undefined,
  startDate: string,
  endDate: string,
  threshold: number
): Promise<FundingEvent[]> {
  const symbolFilter = symbol ? 'AND symbol = {symbol: String}' : ''
  const params: Record<string, unknown> = { exchange, startDate, endDate, threshold }
  if (symbol) params.symbol = symbol

  const client = getClickHouseClient()
  const result = await client.query({
    query: `
      SELECT exchange, symbol, funding_time, toFloat64(funding_rate) AS funding_rate
      FROM funding_rates
      WHERE exchange = {exchange: String}
        ${symbolFilter}
        AND funding_time >= {startDate: DateTime}
        AND funding_time <= {endDate: DateTime}
        AND funding_rate < 0
        AND abs(toFloat64(funding_rate)) >= {threshold: Float64}
      ORDER BY funding_time ASC
    `,
    query_params: params,
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ exchange: string; symbol: string; funding_time: string; funding_rate: number }>()
  return rows.map(r => ({
    exchange: r.exchange,
    symbol: r.symbol,
    funding_time: new Date(r.funding_time.includes('T') ? r.funding_time : `${r.funding_time.replace(' ', 'T')}Z`),
    funding_rate: r.funding_rate,
  }))
}

export async function queryCrossExchangeFundingEvents(
  exchangeA: string,
  exchangeB: string,
  symbol: string | undefined,
  startDate: string,
  endDate: string,
  thresholdA: number,
  maxB: number,
  spreadThreshold: number,
  fundingTimeToleranceSeconds = 60
): Promise<CrossFundingEvent[]> {
  const symbolFilter = symbol ? 'AND a.symbol = {symbol: String}' : ''
  const params: Record<string, unknown> = {
    exchangeA,
    exchangeB,
    startDate,
    endDate,
    thresholdA,
    maxB,
    spreadThreshold,
    fundingTimeToleranceSeconds,
  }
  if (symbol) params.symbol = symbol

  const client = getClickHouseClient()
  const result = await client.query({
    query: `
      SELECT
        a.symbol AS symbol,
        a.funding_time AS funding_time,
        toFloat64(a.funding_rate) AS funding_rate_a,
        toFloat64(b.funding_rate) AS funding_rate_b
      FROM funding_rates a
      INNER JOIN funding_rates b
        ON a.symbol = b.symbol
        AND toStartOfHour(a.funding_time) = toStartOfHour(b.funding_time)
        AND abs(dateDiff('second', a.funding_time, b.funding_time)) <= {fundingTimeToleranceSeconds: UInt32}
      WHERE a.exchange = {exchangeA: String}
        AND b.exchange = {exchangeB: String}
        ${symbolFilter}
        AND a.funding_time >= {startDate: DateTime}
        AND a.funding_time <= {endDate: DateTime}
        AND a.funding_rate < 0
        AND abs(toFloat64(a.funding_rate)) >= {thresholdA: Float64}
        AND abs(toFloat64(b.funding_rate)) <= {maxB: Float64}
        AND (toFloat64(a.funding_rate) - toFloat64(b.funding_rate)) <= -{spreadThreshold: Float64}
      ORDER BY a.funding_time ASC
    `,
    query_params: params,
    format: 'JSONEachRow',
  })

  const rows = await result.json<{
    symbol: string
    funding_time: string
    funding_rate_a: number
    funding_rate_b: number
  }>()
  return rows.map(r => ({
    symbol: r.symbol,
    funding_time: new Date(r.funding_time.includes('T') ? r.funding_time : `${r.funding_time.replace(' ', 'T')}Z`),
    funding_rate_a: r.funding_rate_a,
    funding_rate_b: r.funding_rate_b,
  }))
}

export interface MainCrossFundingEvent {
  symbol: string
  funding_time: Date
  main_funding_rate: number
  target_exchange: string
  target_funding_time: Date
  target_funding_rate: number
}

export async function queryMainExchangeCrossEvents(
  mainExchange: string,
  excludeExchanges: string[],
  symbol: string | undefined,
  startDate: string,
  endDate: string,
  mainThreshold: number,
  minSpread: number,
  fundingTimeToleranceSeconds = 60
): Promise<MainCrossFundingEvent[]> {
  const excluded = Array.from(new Set([...excludeExchanges, mainExchange]))
  const symbolFilter = symbol ? 'AND m.symbol = {symbol: String}' : ''
  const params: Record<string, unknown> = {
    mainExchange,
    excluded,
    startDate,
    endDate,
    mainThreshold,
    minSpread,
    tol: fundingTimeToleranceSeconds,
  }
  if (symbol) params.symbol = symbol

  const client = getClickHouseClient()
  const result = await client.query({
    query: `
      SELECT
        m.symbol AS symbol,
        m.funding_time AS main_funding_time,
        toFloat64(m.funding_rate) AS main_funding_rate,
        t.exchange AS target_exchange,
        t.funding_time AS target_funding_time,
        toFloat64(t.funding_rate) AS target_funding_rate
      FROM funding_rates m
      INNER JOIN funding_rates t
        ON m.symbol = t.symbol
        AND toStartOfHour(m.funding_time) = toStartOfHour(t.funding_time)
        AND abs(dateDiff('second', m.funding_time, t.funding_time)) <= {tol: UInt32}
      WHERE m.exchange = {mainExchange: String}
        AND t.exchange NOT IN {excluded: Array(String)}
        ${symbolFilter}
        AND m.funding_time >= {startDate: DateTime}
        AND m.funding_time <= {endDate: DateTime}
        AND m.funding_rate < 0
        AND abs(toFloat64(m.funding_rate)) >= {mainThreshold: Float64}
        AND (toFloat64(t.funding_rate) - toFloat64(m.funding_rate)) >= {minSpread: Float64}
      ORDER BY m.funding_time ASC, m.symbol ASC, t.exchange ASC
    `,
    query_params: params,
    format: 'JSONEachRow',
  })

  const rows = await result.json<{
    symbol: string
    main_funding_time: string
    main_funding_rate: number
    target_exchange: string
    target_funding_time: string
    target_funding_rate: number
  }>()

  return rows.map(r => ({
    symbol: r.symbol,
    funding_time: new Date(
      r.main_funding_time.includes('T') ? r.main_funding_time : `${r.main_funding_time.replace(' ', 'T')}Z`
    ),
    main_funding_rate: r.main_funding_rate,
    target_exchange: r.target_exchange,
    target_funding_time: new Date(
      r.target_funding_time.includes('T')
        ? r.target_funding_time
        : `${r.target_funding_time.replace(' ', 'T')}Z`
    ),
    target_funding_rate: r.target_funding_rate,
  }))
}
