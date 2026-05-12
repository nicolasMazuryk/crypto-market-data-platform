import { describe, it, expect } from 'vitest'
import { OHLCWindow } from './types.js'
import { detectRealFundingSettlement } from './funding-settlement.js'
import type { OrderbookRow } from '../../db/types.js'
import { toClickHouseDateTime } from '../../db/types.js'

function makeRow(ts: Date, bidOpen: number, bidLow: number): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts: toClickHouseDateTime(ts),
    bid_open: bidOpen,
    bid_high: bidOpen + 1,
    bid_low: bidLow,
    bid_close: bidOpen,
    ask_open: bidOpen + 2,
    ask_high: bidOpen + 3,
    ask_low: bidOpen + 1,
    ask_close: bidOpen + 2,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
  }
}

function makeWindow(fundingTime: Date, offsets: { offset: number; bidOpen: number; bidLow: number }[]): OHLCWindow {
  const rows = offsets.map(({ offset, bidOpen, bidLow }) =>
    makeRow(new Date(fundingTime.getTime() + offset * 1000), bidOpen, bidLow)
  )
  return new OHLCWindow(rows)
}

describe('detectRealFundingSettlement', () => {
  const fundingTime = new Date('2025-06-01T00:00:00Z')

  it('detects the max-drop red candle in the window', () => {
    const window = makeWindow(fundingTime, [
      { offset: 0, bidOpen: 50000, bidLow: 49990 }, // drop = 10
      { offset: 1, bidOpen: 50000, bidLow: 49980 }, // drop = 20 ← winner
      { offset: 2, bidOpen: 50000, bidLow: 49995 }, // drop = 5
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 10)
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(toClickHouseDateTime(new Date(fundingTime.getTime() + 1000)))
    expect(result.dropMagnitude).toBe(20)
  })

  it('skips green and flat candles (drop <= 0)', () => {
    const window = makeWindow(fundingTime, [
      { offset: 0, bidOpen: 50000, bidLow: 50005 }, // green: drop = -5, skipped
      { offset: 1, bidOpen: 50000, bidLow: 50000 }, // flat: drop = 0, skipped
      { offset: 2, bidOpen: 50000, bidLow: 49990 }, // red: drop = 10 ← winner
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 10)
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(toClickHouseDateTime(new Date(fundingTime.getTime() + 2000)))
    expect(result.dropMagnitude).toBe(10)
  })

  it('returns fallback when no red candle exists', () => {
    const window = makeWindow(fundingTime, [
      { offset: 0, bidOpen: 50000, bidLow: 50000 }, // flat
      { offset: 1, bidOpen: 50000, bidLow: 50010 }, // green
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 10)
    expect(result.detected).toBe(false)
    expect(result.settlementTs).toBe(toClickHouseDateTime(fundingTime))
    expect(result.dropMagnitude).toBeNull()
  })

  it('returns fallback when window is empty', () => {
    const window = new OHLCWindow([])
    const result = detectRealFundingSettlement(window, fundingTime, 10)
    expect(result.detected).toBe(false)
    expect(result.settlementTs).toBe(toClickHouseDateTime(fundingTime))
    expect(result.dropMagnitude).toBeNull()
  })

  it('respects window length — candle outside window not selected', () => {
    // 5s window: offsets 0-5 included, offset 6 excluded
    const window = makeWindow(fundingTime, [
      { offset: 0, bidOpen: 50000, bidLow: 49990 }, // drop = 10, inside 5s window
      { offset: 6, bidOpen: 50000, bidLow: 49900 }, // drop = 100, outside 5s window
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 5)
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(toClickHouseDateTime(fundingTime)) // offset 0
    expect(result.dropMagnitude).toBe(10)
  })

  it('tie-break: first candle wins on equal drop', () => {
    const window = makeWindow(fundingTime, [
      { offset: 0, bidOpen: 50000, bidLow: 49990 }, // drop = 10, first
      { offset: 1, bidOpen: 50000, bidLow: 49990 }, // drop = 10, second
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 10)
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(toClickHouseDateTime(fundingTime)) // offset 0 wins
  })

  it('includes candles exactly at fundingTime and endTs boundaries', () => {
    // 2s window: [T, T+2] inclusive
    const window = makeWindow(fundingTime, [
      { offset: 0, bidOpen: 50000, bidLow: 49990 }, // drop = 10, at boundary
      { offset: 2, bidOpen: 50000, bidLow: 49980 }, // drop = 20, at end boundary
    ])
    const result = detectRealFundingSettlement(window, fundingTime, 2)
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(toClickHouseDateTime(new Date(fundingTime.getTime() + 2000)))
    expect(result.dropMagnitude).toBe(20)
  })

  it('handles null bid_open or bid_low gracefully', () => {
    const nullRow: OrderbookRow = {
      exchange: 'binanceusdm',
      symbol: 'BTCUSDT',
      ts: toClickHouseDateTime(fundingTime),
      bid_open: null,
      bid_high: null,
      bid_low: null,
      bid_close: null,
      ask_open: 50002,
      ask_high: 50003,
      ask_low: 50001,
      ask_close: 50002,
      source_type: 'raw',
      is_interpolated: false,
      confidence_score: '1.0',
      missing_reason: null,
    }
    const goodRow = makeRow(new Date(fundingTime.getTime() + 1000), 50000, 49990)
    const window = new OHLCWindow([nullRow, goodRow])
    const result = detectRealFundingSettlement(window, fundingTime, 10)
    expect(result.detected).toBe(true)
    expect(result.settlementTs).toBe(toClickHouseDateTime(new Date(fundingTime.getTime() + 1000)))
  })
})
