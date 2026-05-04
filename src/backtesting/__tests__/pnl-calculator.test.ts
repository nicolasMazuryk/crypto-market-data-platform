import { describe, it, expect } from 'vitest'
import {
  calculateDeltaPnl,
  calculateFundingPnl,
  calculatePnl,
  calculateLadderPnl,
  calculateFee,
} from '../pnl/calculator.js'
import type { FeeSchedule } from '../config/schema.js'

const TOLERANCE = 1e-10

const defaultFees: FeeSchedule = {
  taker_fee: 0.0004,
  maker_fee: 0.0002,
}

describe('P&L Calculator', () => {
  describe('calculateDeltaPnl', () => {
    it('long position: positive when price goes up', () => {
      const result = calculateDeltaPnl('long', 50000, 50500)
      expect(result).toBeCloseTo(0.01, TOLERANCE) // +1%
    })

    it('long position: negative when price goes down', () => {
      const result = calculateDeltaPnl('long', 50000, 49750)
      expect(result).toBeCloseTo(-0.005, TOLERANCE) // -0.5%
    })

    it('short position: positive when price goes down', () => {
      const result = calculateDeltaPnl('short', 50000, 49500)
      expect(result).toBeCloseTo(0.01, TOLERANCE) // +1%
    })

    it('short position: negative when price goes up', () => {
      const result = calculateDeltaPnl('short', 50000, 50250)
      expect(result).toBeCloseTo(-0.005, TOLERANCE) // -0.5%
    })
  })

  describe('calculateFundingPnl', () => {
    it('longs receive +|F| when funding rate is negative (fraction=1)', () => {
      const result = calculateFundingPnl(-0.015, 'long', 1)
      expect(result).toBeCloseTo(0.015, TOLERANCE)
    })

    it('shorts pay -|F| when funding rate is negative (fraction=1)', () => {
      const result = calculateFundingPnl(-0.015, 'short', 1)
      expect(result).toBeCloseTo(-0.015, TOLERANCE)
    })

    it('returns 0 when appliedFraction is 0', () => {
      const result = calculateFundingPnl(-0.015, 'long', 0)
      expect(result).toBe(0)
    })

    it('longs pay when funding rate is positive (fraction=1)', () => {
      const result = calculateFundingPnl(0.01, 'long', 1)
      expect(result).toBeCloseTo(-0.01, TOLERANCE)
    })

    it('scales proportionally for partial fraction', () => {
      expect(calculateFundingPnl(-0.02, 'long', 0.5)).toBeCloseTo(0.01, TOLERANCE)
      expect(calculateFundingPnl(-0.02, 'short', 0.5)).toBeCloseTo(-0.01, TOLERANCE)
    })
  })

  describe('calculateFee', () => {
    it('returns taker fee for taker type', () => {
      expect(calculateFee('taker', defaultFees)).toBe(0.0004)
    })

    it('returns maker fee for maker type', () => {
      expect(calculateFee('maker', defaultFees)).toBe(0.0002)
    })
  })

  describe('calculatePnl (S1: long, instant exit)', () => {
    it('hand-computed S1 profitable trade', () => {
      // F = -1.5%, entry at 50000, exit at 49925 (drop of 0.15%)
      // DELTA_PNL = (49925 - 50000) / 50000 = -0.0015
      // FUNDING_PNL = +0.015
      // FEES = 0.0004 * 2 = 0.0008
      // NET_PNL = -0.0015 + 0.015 - 0.0008 = 0.0127

      const pnl = calculatePnl({
        direction: 'long',
        entryPrice: 50000,
        exitPrice: 49925,
        fundingRate: -0.015,
        appliedFraction: 1,
        entryFeeType: 'taker',
        exitFeeType: 'taker',
        feeSchedule: defaultFees,
      })

      expect(Math.abs(pnl.delta_pnl - -0.0015)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.funding_pnl - 0.015)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.fees - 0.0008)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.net_pnl - 0.0127)).toBeLessThan(TOLERANCE)
    })

    it('hand-computed S1 losing trade', () => {
      // F = -0.5%, entry at 50000, exit at 49600 (drop of 0.8%)
      // DELTA_PNL = -0.008
      // FUNDING_PNL = +0.005
      // FEES = 0.0008
      // NET_PNL = -0.008 + 0.005 - 0.0008 = -0.0038

      const pnl = calculatePnl({
        direction: 'long',
        entryPrice: 50000,
        exitPrice: 49600,
        fundingRate: -0.005,
        appliedFraction: 1,
        entryFeeType: 'taker',
        exitFeeType: 'taker',
        feeSchedule: defaultFees,
      })

      expect(Math.abs(pnl.delta_pnl - -0.008)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.funding_pnl - 0.005)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.net_pnl - -0.0038)).toBeLessThan(TOLERANCE)
    })
  })

  describe('calculatePnl (S3: short, ride the drop)', () => {
    it('hand-computed S3 profitable short', () => {
      // F = -1.0%, entry (sell) at 50000, exit (buy) at 49250
      // DELTA_PNL (short) = (50000 - 49250) / 50000 = 0.015
      // FUNDING_PNL = -0.01 (shorts pay)
      // FEES = taker + maker = 0.0004 + 0.0002 = 0.0006
      // NET_PNL = 0.015 - 0.01 - 0.0006 = 0.0044

      const pnl = calculatePnl({
        direction: 'short',
        entryPrice: 50000,
        exitPrice: 49250,
        fundingRate: -0.01,
        appliedFraction: 1,
        entryFeeType: 'taker',
        exitFeeType: 'maker',
        feeSchedule: defaultFees,
      })

      expect(Math.abs(pnl.delta_pnl - 0.015)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.funding_pnl - -0.01)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.fees - 0.0006)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.net_pnl - 0.0044)).toBeLessThan(TOLERANCE)
    })
  })

  describe('calculateLadderPnl (S4.1)', () => {
    it('hand-computed ladder with 3 fills', () => {
      // 3 fills at prices [49800, 49600, 49400], equal weight
      // P_avg = (49800 + 49600 + 49400) / 3 = 49600
      // Exit at 49700 (TP hit)
      // DELTA_PNL = (49700 - 49600) / 49600 = 0.002016...
      // FUNDING_PNL = 0 (scenario a)
      // FEES = 3 * 0.0002 + 0.0002 = 0.0008
      // NET_PNL = 0.002016... + 0 - 0.0008 = 0.001216...

      const pAvg = (49800 + 49600 + 49400) / 3
      const expectedDelta = (49700 - pAvg) / pAvg

      const pnl = calculateLadderPnl({
        direction: 'long',
        avgEntryPrice: pAvg,
        exitPrice: 49700,
        fundingRate: -0.01,
        appliedFraction: 0, // scenario a
        numFilled: 3,
        exitFeeType: 'maker',
        feeSchedule: defaultFees,
      })

      expect(Math.abs(pnl.delta_pnl - expectedDelta)).toBeLessThan(TOLERANCE)
      expect(pnl.funding_pnl).toBe(0)
      expect(Math.abs(pnl.fees - 0.0008)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.net_pnl - (expectedDelta - 0.0008))).toBeLessThan(TOLERANCE)
    })

    it('ladder with funding included (scenario b)', () => {
      const pAvg = 49600
      const pnl = calculateLadderPnl({
        direction: 'long',
        avgEntryPrice: pAvg,
        exitPrice: 49700,
        fundingRate: -0.01,
        appliedFraction: 1, // scenario b
        numFilled: 3,
        exitFeeType: 'maker',
        feeSchedule: defaultFees,
      })

      expect(Math.abs(pnl.funding_pnl - 0.01)).toBeLessThan(TOLERANCE)
    })
  })
})
