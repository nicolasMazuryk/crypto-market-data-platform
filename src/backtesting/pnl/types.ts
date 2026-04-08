import type { FeeType } from '../orders/types.js'

/** Fee specification for a single order leg */
export interface FeeSpec {
  type: FeeType
  rate: number
}

/** Complete P&L breakdown for a trade */
export interface PnlBreakdown {
  /** Price change P&L: (P_exit - P_entry) / P_entry for long, inverse for short */
  delta_pnl: number
  /** Funding fee P&L: +F for longs receiving, -F for shorts paying, 0 if excluded */
  funding_pnl: number
  /** Total fees paid */
  fees: number
  /** NET_PNL = DELTA_PNL + FUNDING_PNL - FEES */
  net_pnl: number
}
