export interface FeasibilityParams {
  quantity: number
  price: number
  lotStep: number
  minCost: number
  contractSize?: number
}

export interface FeasibilityResult {
  feasible: boolean
  adjustedQuantity: number
  reason?: 'lot_step_zero' | 'below_min_cost'
}

/**
 * Check whether an order quantity is feasible against exchange lot-step and
 * minimum-notional constraints, flooring the quantity to the nearest lot step first.
 *
 * Wired into `strategy-4-1.ts` (ladder rung drop / top-rung skip) against the backtest's
 * default constant market params, since there is no real per-symbol CCXT metadata source.
 */
export function checkOrderFeasibility(params: FeasibilityParams): FeasibilityResult {
  const { quantity, price, lotStep, minCost, contractSize = 1 } = params

  if (lotStep <= 0) {
    return { feasible: false, adjustedQuantity: 0, reason: 'lot_step_zero' }
  }

  const adjustedQuantity = Math.floor(quantity / lotStep) * lotStep
  const notional = adjustedQuantity * price * contractSize

  if (notional < minCost) {
    return { feasible: false, adjustedQuantity, reason: 'below_min_cost' }
  }

  return { feasible: true, adjustedQuantity }
}
