import { describe, it, expect } from 'vitest'
import { applyOrderLatency } from '../engine/latency.js'

describe('applyOrderLatency', () => {
  it('shifts the timestamp forward by orderLatencyMs (1000ms = 1 candle)', () => {
    expect(applyOrderLatency('2025-06-01 00:00:00', 1000)).toBe('2025-06-01 00:00:01')
  })

  it('returns the same timestamp for zero latency', () => {
    expect(applyOrderLatency('2025-06-01 00:00:00', 0)).toBe('2025-06-01 00:00:00')
  })

  it('rolls over across a minute/day boundary', () => {
    expect(applyOrderLatency('2025-06-01 00:00:59', 1000)).toBe('2025-06-01 00:01:00')
    expect(applyOrderLatency('2025-06-01 23:59:59', 1000)).toBe('2025-06-02 00:00:00')
  })
})
