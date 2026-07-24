import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import YAML from 'yaml'

import { generateInstanceConfig } from '../generate-instance-config.js'
import type { FleetEntry } from '../schema.js'
import { deepMerge } from '../../config/loader.js'
import { parseEngineConfig } from '../../config/schema.js'

const BASE_CONFIG = {
  exchanges: [
    {
      exchange: 'bybit',
      enabled: true,
      credentialsEnvPrefix: 'BYBIT',
      marketRefreshMs: 60000,
      fundingPullMs: 10000,
      rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    },
    {
      exchange: 'okx',
      enabled: true,
      credentialsEnvPrefix: 'OKX',
      marketRefreshMs: 60000,
      fundingPullMs: 10000,
      rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    },
  ],
  scheduler: { wakeBeforeHourEndMs: 300000, fundingWindowMs: 600000 },
  persistence: { walPath: '' },
  observability: { metricsPort: 9464, healthPort: 9466 },
}

const STRATEGY_CONFIG = {
  strategies: [
    {
      id: 'strategy_3a',
      enabled: true,
      negativeFundingThresholdPercent: -0.4,
      entryOffsetSeconds: 3,
      stopLossPercent: 1.0,
      tpVariantAMultiplier: 1.8,
      deadlineSeconds: 3300,
      amountUsd: 10,
      leverage: 5,
    },
  ],
}

const FLEET_ENTRY: FleetEntry = {
  id: 'strategy_3a-bybit',
  strategy: 'strategy_3a',
  exchange: 'bybit',
  enabled: true,
  strategy_config: '', // filled in beforeEach
  runtime: { metrics_port: 9501, health_port: 9601, log_level: 'info' },
  risk: { maxConcurrentIntents: 200, maxNotionalUsd: 50000 },
}

let tmpDir: string
let basePath: string
let strategyConfigPath: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `fleet-test-${Date.now().toString()}`)
  mkdirSync(tmpDir, { recursive: true })
  basePath = join(tmpDir, 'execution.base.yaml')
  strategyConfigPath = join(tmpDir, 'strategy_3a-bybit.yaml')
  writeFileSync(basePath, YAML.stringify(BASE_CONFIG), 'utf8')
  writeFileSync(strategyConfigPath, YAML.stringify(STRATEGY_CONFIG), 'utf8')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('generateInstanceConfig', () => {
  it('produces filename matching execution.<id>.yaml', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    expect(result.filename).toBe('execution.strategy_3a-bybit.yaml')
  })

  it('sets mode to live', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    expect(parsed.mode).toBe('live')
  })

  it('includes only the target exchange in exchanges array', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    const exchanges = parsed.exchanges as Record<string, unknown>[]
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]?.exchange).toBe('bybit')
  })

  it('sets target exchange enabled: true', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    const exchanges = parsed.exchanges as Record<string, unknown>[]
    expect(exchanges[0]?.enabled).toBe(true)
  })

  it('applies metrics and health port overrides', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    const obs = parsed.observability as Record<string, unknown>
    expect(obs.metricsPort).toBe(9501)
    expect(obs.healthPort).toBe(9601)
  })

  it('applies risk overrides', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    const risk = parsed.risk as Record<string, unknown>
    expect(risk.globalMaxConcurrentIntents).toBe(200)
    expect(risk.globalMaxNotionalUsd).toBe(50000)
  })

  it('does not set acknowledgeUncapped when notional <= 100k', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath, risk: { maxNotionalUsd: 50000 } }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    const risk = parsed.risk as Record<string, unknown> | undefined
    expect(risk?.acknowledgeUncapped).toBeUndefined()
  })

  it('sets acknowledgeUncapped when notional > 100k', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath, risk: { maxNotionalUsd: 150000 } }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    const risk = parsed.risk as Record<string, unknown>
    expect(risk.acknowledgeUncapped).toBe(true)
  })

  it('includes strategies from strategy_config', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    const strategies = parsed.strategies as Record<string, unknown>[]
    expect(strategies).toHaveLength(1)
    expect(strategies[0]?.id).toBe('strategy_3a')
    expect(strategies[0]?.enabled).toBe(true)
  })

  it('renders YAML that re-parses as an engine config after base merge', () => {
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const override = (YAML.parse(result.content) ?? {}) as Record<string, unknown>

    const parsed = parseEngineConfig(deepMerge(BASE_CONFIG, override))

    expect(parsed.mode).toBe('live')
    expect(parsed.exchanges).toHaveLength(1)
    expect(parsed.strategies.some(s => s.id === 'strategy_3a' && s.enabled)).toBe(true)
  })

  it('throws when strategy_config contains an empty strategies array', () => {
    writeFileSync(strategyConfigPath, YAML.stringify({ strategies: [] }), 'utf8')
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }

    expect(() => generateInstanceConfig({ fleetEntry: entry, basePath })).toThrow(
      /produced no strategies for strategy_3a-bybit/
    )
  })

  it('throws when strategy_config omits strategies', () => {
    writeFileSync(strategyConfigPath, YAML.stringify({ risk: {} }), 'utf8')
    const entry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath }

    expect(() => generateInstanceConfig({ fleetEntry: entry, basePath })).toThrow(
      /produced no strategies for strategy_3a-bybit/
    )
  })

  it('throws when exchange not found in base config', () => {
    const entry: FleetEntry = {
      ...FLEET_ENTRY,
      id: 'strategy_3a-mexc',
      exchange: 'mexc',
      strategy_config: strategyConfigPath,
    }
    expect(() => generateInstanceConfig({ fleetEntry: entry, basePath })).toThrow(/not found in base config/)
  })

  it('omits risk section when no risk overrides set', () => {
    const entry: FleetEntry = { ...FLEET_ENTRY, strategy_config: strategyConfigPath, risk: {} }
    const result = generateInstanceConfig({ fleetEntry: entry, basePath })
    const parsed = YAML.parse(result.content) as Record<string, unknown>
    expect(parsed.risk).toBeUndefined()
  })
})
