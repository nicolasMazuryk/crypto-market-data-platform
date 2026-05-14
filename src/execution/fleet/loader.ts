import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

import { FleetSchema, type Fleet } from './schema.js'
import { loadRegistry } from '../provisioning/registry/loader.js'
import type { Registry } from '../provisioning/registry/schema.js'

export interface LoadFleetOptions {
  /**
   * Path to live-configs/registry.yaml. When provided, cross-validates that
   * each enabled combination has an active registry entry.
   */
  registryPath?: string
  /**
   * Pre-loaded registry. Takes priority over registryPath.
   */
  registry?: Registry
}

export function loadFleet(fleetPath: string, options: LoadFleetOptions = {}): Fleet {
  const source = readFileSync(resolve(fleetPath), 'utf8')
  const raw = (YAML.parse(source) ?? {}) as Record<string, unknown>
  const fleet = FleetSchema.parse(raw)

  const registry = options.registry ?? (options.registryPath ? loadRegistry(options.registryPath) : undefined)

  const errors: string[] = []

  for (const entry of fleet.combinations) {
    if (!existsSync(resolve(entry.strategy_config))) {
      errors.push(`${entry.id}: strategy_config not found: ${entry.strategy_config}`)
    }

    if (entry.enabled && registry) {
      const hasActive = registry.combinations.some(
        c => c.assigned_strategy === entry.strategy && c.exchange === entry.exchange && c.status === 'active'
      )
      if (!hasActive) {
        errors.push(`${entry.id}: no active registry entry for (${entry.strategy}, ${entry.exchange})`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Fleet validation failed:\n${errors.map(e => `  ${e}`).join('\n')}`)
  }

  return fleet
}
