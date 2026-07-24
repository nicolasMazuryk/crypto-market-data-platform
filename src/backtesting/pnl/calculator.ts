import type { FeeSchedule } from '../config/schema.js'
import type { FeeType } from '../orders/types.js'
import type { PnlBreakdown } from './types.js'

/**
 * Calculate fee cost for a single order leg.
 */
export function calculateFee(feeType: FeeType, feeSchedule: FeeSchedule): number {
  return feeType === 'taker' ? feeSchedule.taker_fee : feeSchedule.maker_fee
}

/**
 * Calculate delta P&L based on direction.
 *
 * Long:  (P_exit - P_entry) / P_entry
 * Short: (P_entry - P_exit) / P_entry
 */
export function calculateDeltaPnl(direction: 'long' | 'short', entryPrice: number, exitPrice: number): number {
  if (direction === 'long') {
    return (exitPrice - entryPrice) / entryPrice
  }
  return (entryPrice - exitPrice) / entryPrice
}

/**
 * Calculate funding P&L.
 *
 * For negative funding rates:
 * - Longs receive +|F|
 * - Shorts pay -|F|
 *
 * @param fundingRate - The actual funding rate (negative number for negative funding)
 * @param direction - Position direction
 * @param appliedFraction - 0 = none, 1 = full, in-between = partial (ladder proportional accrual)
 */
export function calculateFundingPnl(fundingRate: number, direction: 'long' | 'short', appliedFraction: number): number {
  if (appliedFraction <= 0) return 0

  // F in the spec is expressed as absolute value. The funding rate from DB is negative.
  // When F is negative: longs receive +|F|, shorts pay -|F|
  const absF = Math.abs(fundingRate)
  const sign = direction === 'long' ? (fundingRate < 0 ? 1 : -1) : fundingRate < 0 ? -1 : 1
  return sign * absF * appliedFraction
}

/**
 * Calculate complete P&L breakdown.
 *
 * NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
 */
export function calculatePnl(params: {
  direction: 'long' | 'short'
  entryPrice: number
  exitPrice: number
  fundingRate: number
  appliedFraction: number
  entryFeeType: FeeType
  exitFeeType: FeeType
  feeSchedule: FeeSchedule
}): PnlBreakdown {
  const delta_pnl = calculateDeltaPnl(params.direction, params.entryPrice, params.exitPrice)
  const funding_pnl = calculateFundingPnl(params.fundingRate, params.direction, params.appliedFraction)
  const entryFee = calculateFee(params.entryFeeType, params.feeSchedule)
  const exitFee = calculateFee(params.exitFeeType, params.feeSchedule)
  const fees = entryFee + exitFee
  const net_pnl = delta_pnl + funding_pnl - fees

  return { delta_pnl, spread_pnl: 0, funding_pnl, fees, net_pnl }
}

/**
 * Calculate P&L for ladder strategies as a capital-weighted return.
 *
 * All components are dollar amounts divided by committed capital (`amount_usd`),
 * so partial ladders (idle unfilled rungs) correctly dilute the return and fees
 * are notional-accurate (entry maker fee on filled notional, not `× numFilled`).
 *
 * NET_PNL = DELTA_PNL + FUNDING_PNL - FEES  (invariant preserved for aggregation)
 */
export function calculateLadderPnl(params: {
  direction: 'long' | 'short'
  /** Weighted average entry price */
  avgEntryPrice: number
  exitPrice: number
  /** Total filled quantity across all rungs */
  filledQty: number
  /** Committed capital = amount_usd (full budget, including idle unfilled rungs) */
  committedCapital: number
  fundingRate: number
  appliedFraction: number
  exitFeeType: FeeType
  feeSchedule: FeeSchedule
}): PnlBreakdown {
  const filledNotional = params.filledQty * params.avgEntryPrice
  const grossProfit =
    params.direction === 'long'
      ? params.filledQty * (params.exitPrice - params.avgEntryPrice)
      : params.filledQty * (params.avgEntryPrice - params.exitPrice)
  const entryFee = params.feeSchedule.maker_fee * filledNotional
  const exitFee = calculateFee(params.exitFeeType, params.feeSchedule) * (params.filledQty * params.exitPrice)
  const funding = calculateFundingPnl(params.fundingRate, params.direction, params.appliedFraction) * filledNotional

  const C = params.committedCapital
  const delta_pnl = grossProfit / C
  const funding_pnl = funding / C
  const fees = (entryFee + exitFee) / C
  const net_pnl = delta_pnl + funding_pnl - fees

  return { delta_pnl, spread_pnl: 0, funding_pnl, fees, net_pnl }
}
