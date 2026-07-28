import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import { loadEventsFromReport } from './report-events.js'

interface LogEntryOverrides {
  timestamp?: string
  symbol?: string
  exchange?: string
  trigger_funding_rate?: number
  error_code?: string | null
  exit_reason?: string | null
  net_pnl?: number | null
  entry_timestamp?: string | null
  exit_timestamp?: string | null
  entry_price?: number | null
  exit_price?: number | null
  sl_price?: number | null
  tp_price?: number | null
}

function tradeEntry(overrides: LogEntryOverrides = {}): Record<string, unknown> {
  return {
    timestamp: '2026-04-16T16:00:00.000Z',
    symbol: 'SIGNUSDT',
    exchange: 'bitget',
    trigger_funding_rate: -0.02,
    error_code: null,
    exit_reason: 'sl_hit',
    net_pnl: -1.21,
    entry_timestamp: '2026-04-16T15:59:57.000Z',
    exit_timestamp: '2026-04-16T15:59:59.000Z',
    entry_price: 0.1,
    exit_price: 0.099,
    sl_price: 0.099,
    tp_price: null,
    ...overrides,
  }
}

function writeReport(tradeLog: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'report-events-'))
  const path = join(dir, 'report.json')
  writeFileSync(path, JSON.stringify({ trade_log: tradeLog }))
  return path
}

describe('loadEventsFromReport', () => {
  it('maps executed trades to funding events carrying the realized trade overlay', () => {
    const events = loadEventsFromReport(writeReport([tradeEntry()]))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      exchange: 'bitget',
      symbol: 'SIGNUSDT',
      funding_rate: -0.02,
    })
    expect(events[0]?.funding_time.toISOString()).toBe('2026-04-16T16:00:00.000Z')
    expect(events[0]?.trade).toMatchObject({
      entry_price: 0.1,
      exit_price: 0.099,
      sl_price: 0.099,
      tp_price: null,
      exit_reason: 'sl_hit',
      net_pnl: -1.21,
    })
    expect(events[0]?.trade?.entry_ts.toISOString()).toBe('2026-04-16T15:59:57.000Z')
  })

  it('drops error entries, which never took a position', () => {
    const path = writeReport([
      tradeEntry(),
      tradeEntry({
        symbol: 'OTHERUSDT',
        error_code: 'limit_expired',
        exit_reason: null,
        net_pnl: null,
        entry_timestamp: null,
        exit_timestamp: null,
        entry_price: null,
        exit_price: null,
        sl_price: null,
      }),
    ])

    const events = loadEventsFromReport(path)

    expect(events.map(e => e.symbol)).toEqual(['SIGNUSDT'])
  })

  it('collapses duplicate exchange/symbol/funding_time triples', () => {
    const events = loadEventsFromReport(writeReport([tradeEntry(), tradeEntry({ net_pnl: 5 })]))

    expect(events).toHaveLength(1)
    expect(events[0]?.trade?.net_pnl).toBe(-1.21)
  })

  it('sorts events chronologically so worker shards stay deterministic', () => {
    const path = writeReport([
      tradeEntry({ timestamp: '2026-05-01T00:00:00.000Z', symbol: 'LATEUSDT' }),
      tradeEntry({ timestamp: '2026-04-01T00:00:00.000Z', symbol: 'EARLYUSDT' }),
    ])

    expect(loadEventsFromReport(path).map(e => e.symbol)).toEqual(['EARLYUSDT', 'LATEUSDT'])
  })

  it('keeps the event but omits the overlay when entry/exit geometry is missing', () => {
    const events = loadEventsFromReport(writeReport([tradeEntry({ entry_timestamp: null, entry_price: null })]))

    expect(events).toHaveLength(1)
    expect(events[0]?.trade).toBeUndefined()
  })

  it('throws when the report has no trade log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-events-'))
    const path = join(dir, 'report.json')
    writeFileSync(path, JSON.stringify({ strategy_id: 'strategy_2' }))

    expect(() => loadEventsFromReport(path)).toThrow(/no trade_log/)
  })
})
