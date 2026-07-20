import { describe, it, expect } from 'vitest'
import type { OrderbookRow } from '../../db/types.js'
import { OHLCWindow } from '../data/types.js'
import { TimeGatedWindow, LookaheadViolationError } from '../engine/lookahead-guard.js'

function makeCandle(ts: string): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts,
    bid_open: 50000,
    bid_high: 50050,
    bid_low: 49950,
    bid_close: 50000,
    ask_open: 50010,
    ask_high: 50060,
    ask_low: 49960,
    ask_close: 50010,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
  }
}

describe('Lookahead Guard', () => {
  it('allows access to past data', () => {
    const rows = [
      makeCandle('2025-06-01 00:00:00'),
      makeCandle('2025-06-01 00:00:01'),
      makeCandle('2025-06-01 00:00:02'),
    ]
    const window = new OHLCWindow(rows)
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:02')

    expect(gated.getRowAt('2025-06-01 00:00:00')).toBeDefined()
    expect(gated.getRowAt('2025-06-01 00:00:01')).toBeDefined()
    expect(gated.getRowAt('2025-06-01 00:00:02')).toBeDefined()
  })

  it('throws LookaheadViolationError for future data via getRowAt', () => {
    const rows = [
      makeCandle('2025-06-01 00:00:00'),
      makeCandle('2025-06-01 00:00:01'),
      makeCandle('2025-06-01 00:00:02'),
    ]
    const window = new OHLCWindow(rows)
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:01')

    expect(() => gated.getRowAt('2025-06-01 00:00:02')).toThrow(LookaheadViolationError)
  })

  it('throws LookaheadViolationError for future data via getRowsInRange', () => {
    const rows = [
      makeCandle('2025-06-01 00:00:00'),
      makeCandle('2025-06-01 00:00:01'),
      makeCandle('2025-06-01 00:00:02'),
    ]
    const window = new OHLCWindow(rows)
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:01')

    expect(() => gated.getRowsInRange('2025-06-01 00:00:00', '2025-06-01 00:00:02')).toThrow(LookaheadViolationError)
  })

  it('throws LookaheadViolationError for future data via hasTimestamp', () => {
    const rows = [makeCandle('2025-06-01 00:00:00')]
    const window = new OHLCWindow(rows)
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:00')

    expect(() => gated.hasTimestamp('2025-06-01 00:00:01')).toThrow(LookaheadViolationError)
  })

  it('advancing time allows previously blocked access', () => {
    const rows = [makeCandle('2025-06-01 00:00:00'), makeCandle('2025-06-01 00:00:01')]
    const window = new OHLCWindow(rows)
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:00')

    expect(() => gated.getRowAt('2025-06-01 00:00:01')).toThrow(LookaheadViolationError)

    gated.advanceTo('2025-06-01 00:00:01')
    expect(gated.getRowAt('2025-06-01 00:00:01')).toBeDefined()
  })

  it('cannot move time backwards', () => {
    const rows = [makeCandle('2025-06-01 00:00:00')]
    const window = new OHLCWindow(rows)
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:01')

    expect(() => {
      gated.advanceTo('2025-06-01 00:00:00')
    }).toThrow('Cannot move time backwards')
  })

  it('localization may read to the window edge; a post-decision future read then throws', () => {
    const rows = [
      makeCandle('2025-06-01 00:00:00'),
      makeCandle('2025-06-01 00:00:01'),
      makeCandle('2025-06-01 00:00:02'),
      makeCandle('2025-06-01 00:00:03'),
    ]
    const window = new OHLCWindow(rows)
    // Engine grants the one sanctioned lookahead: gate opened to the window edge for localization.
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:03')

    // Localization scan to the edge is allowed.
    expect(gated.getRowsInRange('2025-06-01 00:00:00', '2025-06-01 00:00:03')).toHaveLength(4)

    // Strategy then decides at an earlier time and advances the gate causally...
    // (the gate cannot move backwards, so a fresh gated window models per-decision reads).
    const decisionGate = new TimeGatedWindow(window, '2025-06-01 00:00:01')
    expect(decisionGate.getRowAt('2025-06-01 00:00:01')).toBeDefined()
    // A post-decision, non-localization read of a future candle throws.
    expect(() => decisionGate.getRowAt('2025-06-01 00:00:02')).toThrow(LookaheadViolationError)
  })

  it('getRowsUpToCurrent returns only past data', () => {
    const rows = [
      makeCandle('2025-06-01 00:00:00'),
      makeCandle('2025-06-01 00:00:01'),
      makeCandle('2025-06-01 00:00:02'),
    ]
    const window = new OHLCWindow(rows)
    const gated = new TimeGatedWindow(window, '2025-06-01 00:00:01')

    const result = gated.getRowsUpToCurrent()
    expect(result).toHaveLength(2)
    expect(result[0]?.ts).toBe('2025-06-01 00:00:00')
    expect(result[1]?.ts).toBe('2025-06-01 00:00:01')
  })
})
