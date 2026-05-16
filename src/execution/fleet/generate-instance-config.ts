import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

import type { FleetEntry } from './schema.js'
import { deepMerge } from '../config/loader.js'
import { parseEngineConfig } from '../config/schema.js'

export interface GenerateInstanceConfigOptions {
  fleetEntry: FleetEntry
  /**
   * Path to config/execution.base.yaml — used to read exchange definitions.
   */
  basePath: string
}

export interface GeneratedInstanceConfig {
  /** YAML content of the generated per-instance config file */
  content: string
  /** Filename: `execution.<id>.yaml` */
  filename: string
}

export function generateInstanceConfig(options: GenerateInstanceConfigOptions): GeneratedInstanceConfig {
  const { fleetEntry, basePath } = options

  const baseSource = readFileSync(resolve(basePath), 'utf8')
  const baseRaw = (YAML.parse(baseSource) ?? {}) as Record<string, unknown>

  const strategySource = readFileSync(resolve(fleetEntry.strategy_config), 'utf8')
  const strategyRaw = (YAML.parse(strategySource) ?? {}) as Record<string, unknown>

  // Find the target exchange definition from base config
  const allExchanges = (baseRaw.exchanges as Record<string, unknown>[] | undefined) ?? []
  const targetExchange = allExchanges.find(e => e.exchange === fleetEntry.exchange)
  if (!targetExchange) {
    throw new Error(`Exchange "${fleetEntry.exchange}" not found in base config at ${basePath}`)
  }

  // Build the mode-specific override (deep-merged on top of base by loadEngineConfig)
  const override: Record<string, unknown> = {
    mode: 'live',
    // Arrays are replaced (not merged) by deepMerge — only this exchange is active
    exchanges: [{ ...targetExchange, enabled: true }],
  }

  if (strategyRaw.strategies) {
    override.strategies = strategyRaw.strategies
  }

  // Port overrides — deepMerge keeps base tracing config, only ports are replaced
  override.observability = {
    metricsPort: fleetEntry.runtime.metrics_port,
    healthPort: fleetEntry.runtime.health_port,
  }

  const riskOverride: Record<string, unknown> = {}
  if (fleetEntry.risk.maxConcurrentIntents !== undefined) {
    riskOverride.globalMaxConcurrentIntents = fleetEntry.risk.maxConcurrentIntents
  }
  if (fleetEntry.risk.maxNotionalUsd !== undefined) {
    riskOverride.globalMaxNotionalUsd = fleetEntry.risk.maxNotionalUsd
    if (fleetEntry.risk.maxNotionalUsd > 100_000) {
      riskOverride.acknowledgeUncapped = true
    }
  }
  if (Object.keys(riskOverride).length > 0) {
    override.risk = riskOverride
  }

  const strategies = (override.strategies as unknown[] | undefined) ?? []
  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new Error(
      `generate-instance-config: strategy_config "${fleetEntry.strategy_config}" produced no strategies for ${fleetEntry.id}`
    )
  }

  const validated = parseEngineConfig(deepMerge(baseRaw, override))
  if (!validated.strategies.some(s => s.enabled)) {
    throw new Error(`generate-instance-config: no enabled strategies after merge for ${fleetEntry.id}`)
  }

  return {
    content: YAML.stringify(override, { lineWidth: 0 }),
    filename: `execution.${fleetEntry.id}.yaml`,
  }
}
