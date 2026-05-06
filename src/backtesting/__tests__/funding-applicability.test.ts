import { describe, it, expect } from 'vitest'
import { shouldApplyFunding, fundingFractionForLadder } from '../pnl/funding-applicability.js'

const T = '2025-06-01 00:00:00'
const T_MINUS_5 = '2025-05-31 23:59:55'
const T_PLUS_2 = '2025-06-01 00:00:02'
const T_PLUS_60 = '2025-06-01 00:01:00'

describe('shouldApplyFunding', () => {
  it('returns false when entry is after funding tick', () => {
    expect(
      shouldApplyFunding({ entryTs: T_PLUS_2, exitTs: T_PLUS_60, fundingTs: T, fundingAppliedOnSameSecond: true })
    ).toBe(false)
  })

  it('returns false when exit is before funding tick', () => {
    expect(
      shouldApplyFunding({ entryTs: T_MINUS_5, exitTs: T_MINUS_5, fundingTs: T, fundingAppliedOnSameSecond: true })
    ).toBe(false)
  })

  it('returns true when position unambiguously straddles funding tick', () => {
    expect(
      shouldApplyFunding({ entryTs: T_MINUS_5, exitTs: T_PLUS_2, fundingTs: T, fundingAppliedOnSameSecond: false })
    ).toBe(true)
  })

  it('returns flag value when entry equals funding tick (flag=true)', () => {
    expect(shouldApplyFunding({ entryTs: T, exitTs: T_PLUS_60, fundingTs: T, fundingAppliedOnSameSecond: true })).toBe(
      true
    )
  })

  it('returns flag value when entry equals funding tick (flag=false)', () => {
    expect(shouldApplyFunding({ entryTs: T, exitTs: T_PLUS_60, fundingTs: T, fundingAppliedOnSameSecond: false })).toBe(
      false
    )
  })

  it('returns flag value when exit equals funding tick (flag=true)', () => {
    expect(shouldApplyFunding({ entryTs: T_MINUS_5, exitTs: T, fundingTs: T, fundingAppliedOnSameSecond: true })).toBe(
      true
    )
  })

  it('returns flag value when exit equals funding tick (flag=false)', () => {
    expect(shouldApplyFunding({ entryTs: T_MINUS_5, exitTs: T, fundingTs: T, fundingAppliedOnSameSecond: false })).toBe(
      false
    )
  })

  it('returns flag value when both entry and exit equal funding tick (flag=true)', () => {
    expect(shouldApplyFunding({ entryTs: T, exitTs: T, fundingTs: T, fundingAppliedOnSameSecond: true })).toBe(true)
  })

  it('returns flag value when both entry and exit equal funding tick (flag=false)', () => {
    expect(shouldApplyFunding({ entryTs: T, exitTs: T, fundingTs: T, fundingAppliedOnSameSecond: false })).toBe(false)
  })
})

describe('fundingFractionForLadder', () => {
  const makeFill = (timestamp: string, quantity: number) => ({ timestamp, quantity })

  it('returns 0 when all fills are after funding tick', () => {
    const fills = [makeFill(T_PLUS_2, 1), makeFill(T_PLUS_60, 1)]
    expect(
      fundingFractionForLadder({ fills, exitTs: T_PLUS_60, fundingTs: T, fundingAppliedOnSameSecond: false })
    ).toBe(0)
  })

  it('returns 0 when exit is before funding tick', () => {
    const fills = [makeFill(T_MINUS_5, 1)]
    expect(fundingFractionForLadder({ fills, exitTs: T_MINUS_5, fundingTs: T, fundingAppliedOnSameSecond: true })).toBe(
      0
    )
  })

  it('returns 1 when all fills straddle funding tick unambiguously', () => {
    const fills = [makeFill(T_MINUS_5, 1), makeFill(T_MINUS_5, 1)]
    expect(fundingFractionForLadder({ fills, exitTs: T_PLUS_2, fundingTs: T, fundingAppliedOnSameSecond: false })).toBe(
      1
    )
  })

  it('returns proportional fraction for mixed fills (equal quantity)', () => {
    const fills = [makeFill(T_MINUS_5, 1), makeFill(T_PLUS_2, 1)]
    const result = fundingFractionForLadder({
      fills,
      exitTs: T_PLUS_60,
      fundingTs: T,
      fundingAppliedOnSameSecond: false,
    })
    expect(result).toBeCloseTo(0.5)
  })

  it('weights by quantity for mixed fills', () => {
    const fills = [makeFill(T_MINUS_5, 3), makeFill(T_PLUS_2, 1)]
    const result = fundingFractionForLadder({
      fills,
      exitTs: T_PLUS_60,
      fundingTs: T,
      fundingAppliedOnSameSecond: false,
    })
    expect(result).toBeCloseTo(0.75)
  })

  it('applies same-second flag to each fill independently (flag=true)', () => {
    const fills = [makeFill(T, 1), makeFill(T_PLUS_2, 1)]
    const result = fundingFractionForLadder({
      fills,
      exitTs: T_PLUS_60,
      fundingTs: T,
      fundingAppliedOnSameSecond: true,
    })
    expect(result).toBeCloseTo(0.5)
  })

  it('applies same-second flag to each fill independently (flag=false)', () => {
    const fills = [makeFill(T, 1), makeFill(T_PLUS_2, 1)]
    const result = fundingFractionForLadder({
      fills,
      exitTs: T_PLUS_60,
      fundingTs: T,
      fundingAppliedOnSameSecond: false,
    })
    expect(result).toBe(0)
  })

  it('returns 0 for empty fills', () => {
    expect(
      fundingFractionForLadder({ fills: [], exitTs: T_PLUS_60, fundingTs: T, fundingAppliedOnSameSecond: true })
    ).toBe(0)
  })
})
