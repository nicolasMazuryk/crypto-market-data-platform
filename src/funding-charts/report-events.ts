import { readFileSync } from 'fs'

import type { FundingEvent, TradeOverlay } from './types.js'

/**
 * Subset of `TradeLogEntry` (src/backtesting/reporting/types.ts) this module consumes.
 * Kept structural so the chart pipeline does not depend on the backtesting module graph.
 */
interface ReportTradeLogEntry {
  timestamp: string
  symbol: string
  exchange: string
  trigger_funding_rate: number
  error_code: string | null
  exit_reason: string | null
  net_pnl: number | null
  entry_timestamp: string | null
  exit_timestamp: string | null
  entry_price: number | null
  exit_price: number | null
  sl_price: number | null
  tp_price: number | null
}

interface Report {
  trade_log?: ReportTradeLogEntry[]
}

function eventKey(exchange: string, symbol: string, fundingTime: Date): string {
  return `${exchange}|${symbol}|${fundingTime.toISOString()}`
}

/** Build the trade overlay, or undefined when the entry lacks the geometry to draw one. */
function toOverlay(entry: ReportTradeLogEntry): TradeOverlay | undefined {
  const { entry_timestamp, exit_timestamp, entry_price, exit_price } = entry
  if (entry_timestamp === null || exit_timestamp === null || entry_price === null || exit_price === null) {
    return undefined
  }
  return {
    entry_ts: new Date(entry_timestamp),
    exit_ts: new Date(exit_timestamp),
    entry_price,
    exit_price,
    sl_price: entry.sl_price,
    tp_price: entry.tp_price,
    exit_reason: entry.exit_reason ?? 'unknown',
    net_pnl: entry.net_pnl ?? 0,
  }
}

/**
 * Read a backtest report and return one funding event per executed trade, carrying that trade's
 * realized geometry. Error entries (no position taken) are dropped — there is nothing to overlay.
 * Duplicate (exchange, symbol, funding_time) triples collapse to the first occurrence, and the
 * result is sorted chronologically so worker shards stay deterministic.
 */
export function loadEventsFromReport(reportPath: string): FundingEvent[] {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report
  const tradeLog = report.trade_log

  if (!tradeLog || tradeLog.length === 0) {
    throw new Error(
      `report has no trade_log: ${reportPath} — re-run the backtest with reporting.include_trade_log enabled`
    )
  }

  const seen = new Set<string>()
  const events: FundingEvent[] = []

  for (const entry of tradeLog) {
    if (entry.error_code !== null) continue

    const fundingTime = new Date(entry.timestamp)
    const key = eventKey(entry.exchange, entry.symbol, fundingTime)
    if (seen.has(key)) continue
    seen.add(key)

    const overlay = toOverlay(entry)
    events.push({
      exchange: entry.exchange,
      symbol: entry.symbol,
      funding_time: fundingTime,
      funding_rate: entry.trigger_funding_rate,
      ...(overlay === undefined ? {} : { trade: overlay }),
    })
  }

  events.sort((a, b) => a.funding_time.getTime() - b.funding_time.getTime())
  return events
}
