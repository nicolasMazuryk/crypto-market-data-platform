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
 * Calculate P&L for ladder strategies with multiple entry fills.
 *
 * FEES = (num_filled * maker_fee) + exit_fee
 */
export function calculateLadderPnl(params: {
  direction: 'long' | 'short'
  /** Weighted average entry price */
  avgEntryPrice: number
  exitPrice: number
  fundingRate: number
  appliedFraction: number
  numFilled: number
  exitFeeType: FeeType
  feeSchedule: FeeSchedule
}): PnlBreakdown {
  const delta_pnl = calculateDeltaPnl(params.direction, params.avgEntryPrice, params.exitPrice)
  const funding_pnl = calculateFundingPnl(params.fundingRate, params.direction, params.appliedFraction)
  const entryFees = params.numFilled * params.feeSchedule.maker_fee
  const exitFee = calculateFee(params.exitFeeType, params.feeSchedule)
  const fees = entryFees + exitFee
  const net_pnl = delta_pnl + funding_pnl - fees

  return { delta_pnl, spread_pnl: 0, funding_pnl, fees, net_pnl }
}

/**
 * Calculate P&L for the spot-futures delta-neutral carry strategy.
 *
 * Position: LONG spot + SHORT perp.
 * NET_PNL = SPREAD_PNL + FUNDING_PNL - FEES
 */
export function calculateSpotFuturesPnl(params: {
  /** (perp_entry - spot_entry) / spot_entry */
  entrySpread: number
  /** (perp_exit - spot_exit) / spot_entry */
  exitSpread: number
  /** Sum of funding_rate across all collected funding events */
  cumulativeFundingRate: number
  /** Spot taker fee per order leg */
  spotFeePerLeg: number
  /** Perp taker fee per order leg */
  perpTakerFee: number
}): PnlBreakdown {
  const spread_pnl = params.entrySpread - params.exitSpread
  const funding_pnl = params.cumulativeFundingRate
  const fees = 2 * params.spotFeePerLeg + 2 * params.perpTakerFee
  const net_pnl = spread_pnl + funding_pnl - fees
  return { delta_pnl: 0, spread_pnl, funding_pnl, fees, net_pnl }
}
