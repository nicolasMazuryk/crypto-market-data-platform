import { EXCHANGE_CAPABILITIES } from '../provisioning/capabilities.js'
import type { Fleet } from './schema.js'
import type { Registry } from '../provisioning/registry/schema.js'

export interface FleetValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function validateFleet(fleet: Fleet, registry: Registry): FleetValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const enabledCountByExchange = new Map<string, number>()
  for (const entry of fleet.combinations) {
    if (entry.enabled) {
      enabledCountByExchange.set(entry.exchange, (enabledCountByExchange.get(entry.exchange) ?? 0) + 1)
    }
  }

  for (const [exchange, count] of enabledCountByExchange) {
    const caps = EXCHANGE_CAPABILITIES[exchange as keyof typeof EXCHANGE_CAPABILITIES] as
      | (typeof EXCHANGE_CAPABILITIES)[keyof typeof EXCHANGE_CAPABILITIES]
      | undefined
    if (!caps) continue
    const max = caps.maxSubAccounts
    if (max !== null && count > max) {
      errors.push(
        `exchange "${exchange}": ${count.toString()} enabled combinations exceeds sub-account limit of ${max.toString()}`
      )
    }
  }

  for (const entry of fleet.combinations) {
    if (!entry.enabled) continue

    const regEntry = registry.combinations.find(
      c => c.assigned_strategy === entry.strategy && c.exchange === entry.exchange
    )
    if (!regEntry) {
      errors.push(`${entry.id}: no registry entry found (run provision)`)
    } else if (regEntry.status !== 'active') {
      errors.push(`${entry.id}: registry entry has status "${regEntry.status}" (expected "active")`)
    }

    if (entry.risk.maxNotionalUsd !== undefined && entry.risk.maxNotionalUsd > 100_000) {
      warnings.push(
        `${entry.id}: maxNotionalUsd ${entry.risk.maxNotionalUsd.toLocaleString()} > $100k — acknowledgeUncapped will be set in generated config`
      )
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
