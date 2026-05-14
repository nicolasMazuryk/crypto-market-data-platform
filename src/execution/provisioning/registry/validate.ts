import { EXCHANGE_CAPABILITIES } from '../capabilities.js'
import type { Registry } from './schema.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateRegistry(registry: Registry, knownStrategies?: Set<string>): ValidationResult {
  const errors: string[] = []

  const totalCountByExchange = new Map<string, number>()
  for (const entry of registry.combinations) {
    totalCountByExchange.set(entry.exchange, (totalCountByExchange.get(entry.exchange) ?? 0) + 1)
  }

  for (const entry of registry.combinations) {
    const label = `(${entry.assigned_strategy ?? 'idle'}, ${entry.exchange}, ${entry.sub_account_id})`
    if (knownStrategies && entry.assigned_strategy !== null && !knownStrategies.has(entry.assigned_strategy)) {
      errors.push(`${label}: unknown strategy "${entry.assigned_strategy}"`)
    }

    const caps = EXCHANGE_CAPABILITIES[entry.exchange]
    if (caps.mode !== entry.provisioning_mode) {
      errors.push(
        `${label}: provisioning_mode is "${entry.provisioning_mode}" but capability table says "${caps.mode}"`
      )
    }
  }

  for (const [exchange, count] of totalCountByExchange) {
    const caps = (
      EXCHANGE_CAPABILITIES as Record<
        string,
        (typeof EXCHANGE_CAPABILITIES)[keyof typeof EXCHANGE_CAPABILITIES] | undefined
      >
    )[exchange]
    if (!caps) continue
    const max = caps.maxSubAccounts
    if (max !== null && count > max) {
      errors.push(`exchange "${exchange}": ${String(count)} registered sub-accounts exceeds limit of ${String(max)}`)
    }
  }

  return { valid: errors.length === 0, errors }
}
