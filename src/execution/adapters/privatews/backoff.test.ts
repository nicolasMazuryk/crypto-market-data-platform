import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { jitteredBackoff } from './backoff.js'

describe('jitteredBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns ~1000ms for attempt 0 (no jitter)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(jitteredBackoff(0)).toBe(1000)
  })

  it('returns ~2000ms for attempt 1 (no jitter)', () => {
    expect(jitteredBackoff(1)).toBe(2000)
  })

  it('returns ~4000ms for attempt 2 (no jitter)', () => {
    expect(jitteredBackoff(2)).toBe(4000)
  })

  it('caps at ~8000ms for attempts >= 3 (no jitter)', () => {
    expect(jitteredBackoff(3)).toBe(8000)
    expect(jitteredBackoff(10)).toBe(8000)
  })

  it('applies +25% jitter at max random', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(jitteredBackoff(0)).toBe(1250)
  })

  it('applies -25% jitter at min random', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(jitteredBackoff(0)).toBe(750)
  })

  it('stays within ±25% bounds for all attempts', () => {
    for (let attempt = 0; attempt <= 4; attempt++) {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const lower = jitteredBackoff(attempt)
      vi.spyOn(Math, 'random').mockReturnValue(1)
      const upper = jitteredBackoff(attempt)
      const mid = (lower + upper) / 2
      expect(upper - lower).toBeCloseTo(mid * 0.5, -1)
      expect(lower).toBeGreaterThan(0)
    }
  })
})
