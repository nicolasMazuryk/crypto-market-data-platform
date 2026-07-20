import { describe, it, expect } from 'vitest'
import { checkOrderFeasibility } from '../orders/feasibility.js'

describe('checkOrderFeasibility', () => {
  it('is infeasible when lotStep is zero', () => {
    const result = checkOrderFeasibility({ quantity: 1, price: 100, lotStep: 0, minCost: 5 })
    expect(result.feasible).toBe(false)
    expect(result.reason).toBe('lot_step_zero')
    expect(result.adjustedQuantity).toBe(0)
  })

  it('is infeasible when notional is below minCost after flooring to lotStep', () => {
    // qty floors to 0.001, notional = 0.001 * 100 = 0.1, below minCost of 5
    const result = checkOrderFeasibility({ quantity: 0.0015, price: 100, lotStep: 0.001, minCost: 5 })
    expect(result.feasible).toBe(false)
    expect(result.reason).toBe('below_min_cost')
    expect(result.adjustedQuantity).toBeCloseTo(0.001, 10)
  })

  it('is feasible when both lot-step and minCost are satisfied, returning the floored quantity', () => {
    // qty floors to 0.1, notional = 0.1 * 100 = 10, above minCost of 5
    const result = checkOrderFeasibility({ quantity: 0.105, price: 100, lotStep: 0.1, minCost: 5 })
    expect(result.feasible).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(result.adjustedQuantity).toBeCloseTo(0.1, 10)
  })

  it('applies contractSize to the notional calculation', () => {
    const result = checkOrderFeasibility({ quantity: 1, price: 1, lotStep: 1, minCost: 5, contractSize: 10 })
    expect(result.feasible).toBe(true)
    expect(result.adjustedQuantity).toBe(1)
  })
})
