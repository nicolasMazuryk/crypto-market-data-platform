import { describe, it, expect } from 'vitest'

import { EXIT_REASONS, ERROR_CODES, isExitReason, isErrorCode } from './enums.js'

describe('canonical terminal-state enums', () => {
  it('EXIT_REASONS matches the §12.1 registry exactly', () => {
    expect([...EXIT_REASONS]).toEqual([
      'timed',
      'funding_fee_event',
      'funding_fee_timeout',
      'tp_hit',
      'sl_hit',
      'deadline',
      'kill_switch_flatten',
    ])
  })

  it('ERROR_CODES matches the §12.2 registry exactly', () => {
    expect([...ERROR_CODES]).toEqual([
      'kill_switch',
      'limit_expired',
      'ladder_no_fills',
      'pre_funding_order_failed',
      'pre_funding_order_rejected',
      'pre_funding_not_filled',
      'funding_event_timeout',
      'main_order_failed',
      'main_order_rejected',
      'close_pre_funding_failed',
    ])
  })

  it('isExitReason accepts only §12.1 values', () => {
    for (const r of EXIT_REASONS) expect(isExitReason(r)).toBe(true)
  })

  it('isExitReason rejects legacy and foreign values', () => {
    for (const v of ['TP_HIT', 'SL_HIT', 'MARKET_EXIT', 'tp', 'sl', 'kill_switch', 'error', '', 42, null, undefined]) {
      expect(isExitReason(v)).toBe(false)
    }
  })

  it('isErrorCode accepts only §12.2 values', () => {
    for (const c of ERROR_CODES) expect(isErrorCode(c)).toBe(true)
  })

  it('isErrorCode rejects exit reasons and foreign values', () => {
    for (const v of ['tp_hit', 'sl_hit', 'timed', 'no_adapter', 'order_rejected', '', 7, null, undefined]) {
      expect(isErrorCode(v)).toBe(false)
    }
  })

  it('the two registries are disjoint', () => {
    const exit = new Set<string>(EXIT_REASONS)
    for (const c of ERROR_CODES) expect(exit.has(c)).toBe(false)
  })
})
