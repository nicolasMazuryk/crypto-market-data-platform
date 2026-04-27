import { describe, expect, it } from 'vitest'

import type { EvalContext, StrategyRule, TradeIntent } from './types.js'
import { createStrategyRegistry } from './registry.js'

function makeRule(id: 'strategy_1' | 'strategy_3a' | 'strategy_3b'): StrategyRule {
  return {
    id,
    evaluate(_ctx: EvalContext): TradeIntent[] {
      return []
    },
  }
}

describe('StrategyRegistry', () => {
  it('registers and retrieves a rule by id', () => {
    const registry = createStrategyRegistry()
    const rule = makeRule('strategy_1')
    registry.register(rule)
    expect(registry.get('strategy_1')).toBe(rule)
  })

  it('returns undefined for unregistered id', () => {
    const registry = createStrategyRegistry()
    expect(registry.get('strategy_1')).toBeUndefined()
  })

  it('lists all registered rules', () => {
    const registry = createStrategyRegistry()
    const r1 = makeRule('strategy_1')
    const r3a = makeRule('strategy_3a')
    registry.register(r1)
    registry.register(r3a)
    expect(registry.list()).toHaveLength(2)
    expect(registry.list()).toContain(r1)
    expect(registry.list()).toContain(r3a)
  })

  it('overwrites a rule with the same id', () => {
    const registry = createStrategyRegistry()
    const r1 = makeRule('strategy_1')
    const r2 = makeRule('strategy_1')
    registry.register(r1)
    registry.register(r2)
    expect(registry.get('strategy_1')).toBe(r2)
    expect(registry.list()).toHaveLength(1)
  })
})
