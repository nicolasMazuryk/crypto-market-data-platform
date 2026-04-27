import type { StrategyId, StrategyRule } from './types.js'

export interface StrategyRegistry {
  register(rule: StrategyRule): void
  get(id: StrategyId): StrategyRule | undefined
  list(): StrategyRule[]
}

export function createStrategyRegistry(): StrategyRegistry {
  const rules = new Map<StrategyId, StrategyRule>()

  return {
    register(rule: StrategyRule): void {
      rules.set(rule.id, rule)
    },
    get(id: StrategyId): StrategyRule | undefined {
      return rules.get(id)
    },
    list(): StrategyRule[] {
      return Array.from(rules.values())
    },
  }
}
