import { getClickHouseClient } from '../../db/client.js'
import type { FundingEvent } from './types.js'

export interface CrossFundingEvent {
  funding_time: Date
  funding_rate_a: number
  funding_rate_b: number
}

export async function queryFundingEvents(
  exchange: string,
  symbol: string,
  startDate: string,
  endDate: string,
  threshold: number
): Promise<FundingEvent[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `
      SELECT exchange, symbol, funding_time, toFloat64(funding_rate) AS funding_rate
      FROM funding_rates
      WHERE exchange = {exchange: String}
        AND symbol = {symbol: String}
        AND funding_time >= {startDate: DateTime}
        AND funding_time <= {endDate: DateTime}
        AND funding_rate < 0
        AND abs(toFloat64(funding_rate)) >= {threshold: Float64}
      ORDER BY funding_time ASC
    `,
    query_params: { exchange, symbol, startDate, endDate, threshold },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ exchange: string; symbol: string; funding_time: string; funding_rate: number }>()
  return rows.map(r => ({
    exchange: r.exchange,
    symbol: r.symbol,
    funding_time: new Date(r.funding_time.includes('T') ? r.funding_time : `${r.funding_time.replace(' ', 'T')}Z`),
    funding_rate: Number(r.funding_rate),
  }))
}

export async function queryCrossExchangeFundingEvents(
  exchangeA: string,
  exchangeB: string,
  symbol: string,
  startDate: string,
  endDate: string,
  thresholdA: number,
  maxB: number,
  spreadThreshold: number
): Promise<CrossFundingEvent[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `
      SELECT
        a.funding_time AS funding_time,
        toFloat64(a.funding_rate) AS funding_rate_a,
        toFloat64(b.funding_rate) AS funding_rate_b
      FROM funding_rates a
      INNER JOIN funding_rates b
        ON a.symbol = b.symbol
        AND a.funding_time = b.funding_time
      WHERE a.exchange = {exchangeA: String}
        AND b.exchange = {exchangeB: String}
        AND a.symbol = {symbol: String}
        AND a.funding_time >= {startDate: DateTime}
        AND a.funding_time <= {endDate: DateTime}
        AND a.funding_rate < 0
        AND abs(toFloat64(a.funding_rate)) >= {thresholdA: Float64}
        AND abs(toFloat64(b.funding_rate)) <= {maxB: Float64}
        AND (toFloat64(a.funding_rate) - toFloat64(b.funding_rate)) <= -{spreadThreshold: Float64}
      ORDER BY a.funding_time ASC
    `,
    query_params: { exchangeA, exchangeB, symbol, startDate, endDate, thresholdA, maxB, spreadThreshold },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ funding_time: string; funding_rate_a: number; funding_rate_b: number }>()
  return rows.map(r => ({
    funding_time: new Date(r.funding_time.includes('T') ? r.funding_time : `${r.funding_time.replace(' ', 'T')}Z`),
    funding_rate_a: Number(r.funding_rate_a),
    funding_rate_b: Number(r.funding_rate_b),
  }))
}
