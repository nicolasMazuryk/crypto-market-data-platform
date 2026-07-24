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

  describe('calculateLadderPnl (S4.1, capital-weighted)', () => {
    it('hand-computed full ladder (5/5 rungs filled)', () => {
      // amount_usd = 20 committed. All 5 rungs filled: filledNotional = 20.
      // pAvg = 100, exit = 101 (+1% move on filled notional).
      // grossProfit = 0.20 * (101 - 100) = 0.20
      // entryFee = maker * filledNotional = 0.0002 * 20 = 0.004
      // exitFee  = maker * (filledQty * exit) = 0.0002 * (0.20 * 101) = 0.004040
      // delta_pnl = 0.20 / 20 = 0.01 ; fees = (0.004 + 0.004040) / 20
      const C = 20
      const pAvg = 100
      const exitPrice = 101
      const filledQty = 0.2
      const filledNotional = filledQty * pAvg
      const expectedDelta = (filledQty * (exitPrice - pAvg)) / C
      const expectedFees = (0.0002 * filledNotional + 0.0002 * (filledQty * exitPrice)) / C

      const pnl = calculateLadderPnl({
        direction: 'long',
        avgEntryPrice: pAvg,
        exitPrice,
        filledQty,
        committedCapital: C,
        fundingRate: -0.01,
        appliedFraction: 0, // scenario a
        exitFeeType: 'maker',
        feeSchedule: defaultFees,
      })

      expect(Math.abs(pnl.delta_pnl - expectedDelta)).toBeLessThan(TOLERANCE)
      expect(pnl.funding_pnl).toBe(0)
      expect(Math.abs(pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.net_pnl - (expectedDelta - expectedFees))).toBeLessThan(TOLERANCE)
    })

    it('partial fill (1 of 5 rungs) dilutes the return by idle capital', () => {
      // Only 1 rung fills: filledNotional = 4, but committed capital still 20.
      // Same +1% move on filled notional -> capital-weighted delta = 0.01 * (4/20) = 0.002.
      const C = 20
      const pAvg = 100
      const exitPrice = 101
      const filledQty = 0.04 // filledNotional = 4 (one of five ~$4 rungs)
      const filledNotional = filledQty * pAvg
      const expectedDelta = (filledQty * (exitPrice - pAvg)) / C
      const expectedFees = (0.0002 * filledNotional + 0.0002 * (filledQty * exitPrice)) / C

      const pnl = calculateLadderPnl({
        direction: 'long',
        avgEntryPrice: pAvg,
        exitPrice,
        filledQty,
        committedCapital: C,
        fundingRate: -0.01,
        appliedFraction: 0,
        exitFeeType: 'maker',
        feeSchedule: defaultFees,
      })

      // 1% move on filled notional collapses to ~0.2% of committed capital.
      expect(Math.abs(pnl.delta_pnl - 0.002)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.delta_pnl - expectedDelta)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.fees - expectedFees)).toBeLessThan(TOLERANCE)
      expect(Math.abs(pnl.net_pnl - (expectedDelta - expectedFees))).toBeLessThan(TOLERANCE)
    })

    it('ladder with funding included (scenario b) — notional-weighted over committed capital', () => {
      const C = 20
      const pAvg = 100
      const filledQty = 0.2
      const filledNotional = filledQty * pAvg
      // funding = |F| * filledNotional / C = 0.01 * 20 / 20 = 0.01
      const expectedFunding = (0.01 * filledNotional) / C

      const pnl = calculateLadderPnl({
        direction: 'long',
        avgEntryPrice: pAvg,
        exitPrice: 101,
        filledQty,
        committedCapital: C,
        fundingRate: -0.01,
        appliedFraction: 1, // scenario b
        exitFeeType: 'maker',
        feeSchedule: defaultFees,
      })

      expect(Math.abs(pnl.funding_pnl - expectedFunding)).toBeLessThan(TOLERANCE)
    })
  })
})
