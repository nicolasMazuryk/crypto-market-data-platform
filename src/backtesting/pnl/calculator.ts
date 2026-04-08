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
 * If include_funding is false, returns 0.
 *
 * @param fundingRate - The actual funding rate (negative number for negative funding)
 * @param direction - Position direction
 * @param includeFunding - Whether funding applies
 */
export function calculateFundingPnl(fundingRate: number, direction: 'long' | 'short', includeFunding: boolean): number {
  if (!includeFunding) return 0

  // F in the spec is expressed as absolute value. The funding rate from DB is negative.
  // When F is negative: longs receive +|F|, shorts pay -|F|
  const absF = Math.abs(fundingRate)

  if (direction === 'long') {
    // Longs receive funding when rate is negative
    return fundingRate < 0 ? absF : -absF
  }
  // Shorts pay funding when rate is negative
  return fundingRate < 0 ? -absF : absF
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
  includeFunding: boolean
  entryFeeType: FeeType
  exitFeeType: FeeType
  feeSchedule: FeeSchedule
}): PnlBreakdown {
  const delta_pnl = calculateDeltaPnl(params.direction, params.entryPrice, params.exitPrice)
  const funding_pnl = calculateFundingPnl(params.fundingRate, params.direction, params.includeFunding)
  const entryFee = calculateFee(params.entryFeeType, params.feeSchedule)
  const exitFee = calculateFee(params.exitFeeType, params.feeSchedule)
  const fees = entryFee + exitFee
  const net_pnl = delta_pnl + funding_pnl - fees

  return { delta_pnl, funding_pnl, fees, net_pnl }
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
  includeFunding: boolean
  numFilled: number
  exitFeeType: FeeType
  feeSchedule: FeeSchedule
}): PnlBreakdown {
  const delta_pnl = calculateDeltaPnl(params.direction, params.avgEntryPrice, params.exitPrice)
  const funding_pnl = calculateFundingPnl(params.fundingRate, params.direction, params.includeFunding)
  const entryFees = params.numFilled * params.feeSchedule.maker_fee
  const exitFee = calculateFee(params.exitFeeType, params.feeSchedule)
  const fees = entryFees + exitFee
  const net_pnl = delta_pnl + funding_pnl - fees

  return { delta_pnl, funding_pnl, fees, net_pnl }
}
