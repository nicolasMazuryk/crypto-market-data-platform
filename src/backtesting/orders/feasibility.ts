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
 * NOT YET WIRED into simulateOrders/simulateLadderOrders/any strategy (task 12 scope).
 * Backtesting order quantities are normalized units (e.g. `1`), not real contract size —
 * there is no `amount_usd`/leverage threading yet, so applying this against today's
 * normalized qty and a stub `minCost` would produce numbers that look precise but aren't.
 * Full wiring lands in task 19/20 once ladder order sizing uses real notional amounts.
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
